const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const { runOpencode } = require("../opencode-runner.cjs");

const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
const AGENT_LOOP_TEMPLATE_ID = "opencode-agent-loop-v1";
const WORKFLOW_TEMPLATE_ID = "opencode-research-verify-workflow-v1";
const BLUEPRINT_ID = "opencode-research-verify-blueprint-v1";
const TEMPLATE_VERSION = 1;
const MAX_SESSION_ATTEMPTS = 3;
const MAX_CORRECTION_ROUNDS = 3;
const MAX_WORKFLOW_NODES = 6;
const MAX_CONCURRENT_WORKFLOW_SESSIONS = 2;
const WORKFLOW_NODE_REGISTRY = Object.freeze({
  kinds: Object.freeze(["delegate", "verify"]),
});

/**
 * Narrow, real Runtime harness for one OpenCode Agent Loop that invokes one
 * bounded Workflow. It deliberately owns only deterministic state transitions;
 * Session Authority remains the sole PTY/process owner.
 */
function createOrchestrationHarness({
  sessionAuthority,
  ptyManager,
  sessionStore,
  opencodePath,
  databasePath = ":memory:",
  runOpenCode = runOpencode,
  now = () => new Date().toISOString(),
  randomUUID = crypto.randomUUID,
  maxConcurrentWorkflowSessions = MAX_CONCURRENT_WORKFLOW_SESSIONS,
  openCodeHookService,
} = {}) {
  if (!sessionAuthority?.registerLaunchProfile || !sessionAuthority?.activateSession) {
    throw new Error("Orchestration Harness requires Session Authority.");
  }
  if (!ptyManager?.read) throw new Error("Orchestration Harness requires PTY output reads.");
  if (!sessionStore?.recordTaskEvent) throw new Error("Orchestration Harness requires the Session Store.");
  if (!opencodePath) throw new Error("Orchestration Harness requires a resolved OpenCode path.");
  if (!Number.isSafeInteger(maxConcurrentWorkflowSessions) || maxConcurrentWorkflowSessions < 1) {
    throw new Error("Orchestration Harness requires a positive workflow concurrency limit.");
  }

  ensureDatabaseDirectory(databasePath);
  const db = new DatabaseSync(databasePath);
  migrate(db);
  ensureSeedTemplates();

  function ensureSeedTemplates() {
    const loop = saveTemplateVersion(seedAgentLoopTemplate(), { preserveVersion: true });
    const workflow = saveTemplateVersion(seedWorkflowTemplate(), { preserveVersion: true });
    saveTemplateBlueprint(seedTemplateBlueprint({ loop, workflow }), { preserveVersion: true });
    upgradeLegacyDeepSearchBlueprint();
    return listTemplates();
  }

  // Preserve the user's original v2 Blueprint as an immutable historical
  // template. Its own description says "single-pass", which is precisely the
  // behavior we are retiring. The new version has an explicit Loop policy;
  // existing Task Architectures keep their original provenance.
  function upgradeLegacyDeepSearchBlueprint() {
    const legacy = getTemplateBlueprint({ blueprintId: "blueprint-deepsearch", version: 2 });
    const current = getTemplateBlueprint({ blueprintId: "blueprint-deepsearch" });
    if (!legacy || Number(current?.version ?? 0) >= 3) return;
    const previousLoop = getTemplate({
      templateId: legacy.agentLoopTemplate.id,
      version: legacy.agentLoopTemplate.version,
    });
    if (!previousLoop) return;
    const loop = saveTemplateVersion({
      id: previousLoop.id,
      family: "agent_loop",
      version: 2,
      name: "DeepSearch Agent Loop",
      definition: dynamicLoopDefinition({
        conductor: previousLoop.definition.conductor,
        nestedWorkflow: previousLoop.definition.nestedWorkflow,
      }),
    });
    saveTemplateBlueprint({
      id: legacy.id,
      version: 3,
      name: "DeepSearch",
      description:
        "Conductor-managed DeepSearch: a bounded search Workflow returns evidence to the Agent Loop; every correction or re-verification Session wakes Conductor for the next evidence-based decision.",
      agentLoopTemplate: templateReference(loop),
      workflowTemplate: legacy.workflowTemplate,
      source: legacy.source,
    });
  }

  function listTemplateBlueprints() {
    return db
      .prepare(
        `SELECT b.blueprint_id, b.version, b.name, b.description, b.agent_loop_template_id, b.agent_loop_template_version,
                b.workflow_template_id, b.workflow_template_version, b.source, b.created_at, b.updated_at
         FROM orchestration_template_blueprints b
         INNER JOIN (
           SELECT blueprint_id, MAX(version) AS version
           FROM orchestration_template_blueprints
           GROUP BY blueprint_id
         ) latest ON latest.blueprint_id = b.blueprint_id AND latest.version = b.version
         ORDER BY b.updated_at DESC, b.blueprint_id ASC`,
      )
      .all()
      .map(deserializeTemplateBlueprint);
  }

  function getTemplateBlueprint({ blueprintId, version } = {}) {
    const id = requiredString(blueprintId, "blueprintId");
    const row = Number.isFinite(Number(version))
      ? db
          .prepare(
            `SELECT blueprint_id, version, name, description, agent_loop_template_id, agent_loop_template_version,
                    workflow_template_id, workflow_template_version, source, created_at, updated_at
             FROM orchestration_template_blueprints WHERE blueprint_id = ? AND version = ?`,
          )
          .get(id, Number(version))
      : db
          .prepare(
            `SELECT blueprint_id, version, name, description, agent_loop_template_id, agent_loop_template_version,
                    workflow_template_id, workflow_template_version, source, created_at, updated_at
             FROM orchestration_template_blueprints WHERE blueprint_id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(id);
    return row ? deserializeTemplateBlueprint(row) : undefined;
  }

  function saveTemplateBlueprint(input, { preserveVersion = false } = {}) {
    const normalized = normalizeTemplateBlueprint(input);
    const existing = getTemplateBlueprint({ blueprintId: normalized.id, version: normalized.version });
    const version = preserveVersion
      ? normalized.version
      : Math.max(
          normalized.version,
          Number(
            db
              .prepare("SELECT MAX(version) AS version FROM orchestration_template_blueprints WHERE blueprint_id = ?")
              .get(normalized.id)?.version ?? 0,
          ) + 1,
        );
    if (existing && preserveVersion) return existing;
    const timestamp = now();
    db.prepare(
      `INSERT INTO orchestration_template_blueprints
       (blueprint_id, version, name, description, agent_loop_template_id, agent_loop_template_version,
        workflow_template_id, workflow_template_version, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(blueprint_id, version) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         agent_loop_template_id = excluded.agent_loop_template_id,
         agent_loop_template_version = excluded.agent_loop_template_version,
         workflow_template_id = excluded.workflow_template_id,
         workflow_template_version = excluded.workflow_template_version,
         source = excluded.source,
         updated_at = excluded.updated_at`,
    ).run(
      normalized.id,
      version,
      normalized.name,
      normalized.description,
      normalized.agentLoopTemplate.id,
      normalized.agentLoopTemplate.version,
      normalized.workflowTemplate.id,
      normalized.workflowTemplate.version,
      normalized.source,
      timestamp,
      timestamp,
    );
    return getTemplateBlueprint({ blueprintId: normalized.id, version });
  }

  function listTemplates() {
    return db
      .prepare(
        `SELECT id, family, version, name, definition_json, created_at, updated_at
         FROM orchestration_template_versions
         ORDER BY family ASC, id ASC, version DESC`,
      )
      .all()
      .map(deserializeTemplate);
  }

  function getTemplate({ templateId, version } = {}) {
    const id = requiredString(templateId, "templateId");
    const row = Number.isFinite(Number(version))
      ? db
          .prepare(
            `SELECT id, family, version, name, definition_json, created_at, updated_at
             FROM orchestration_template_versions WHERE id = ? AND version = ?`,
          )
          .get(id, Number(version))
      : db
          .prepare(
            `SELECT id, family, version, name, definition_json, created_at, updated_at
             FROM orchestration_template_versions WHERE id = ? ORDER BY version DESC LIMIT 1`,
          )
          .get(id);
    return row ? deserializeTemplate(row) : undefined;
  }

  function saveTemplateVersion(input, { preserveVersion = false } = {}) {
    const normalized = normalizeTemplate(input);
    const existing = getTemplate({ templateId: normalized.id, version: normalized.version });
    const version = preserveVersion
      ? normalized.version
      : Math.max(
          normalized.version,
          Number(
            db
              .prepare("SELECT MAX(version) AS version FROM orchestration_template_versions WHERE id = ?")
              .get(normalized.id)?.version ?? 0,
          ) + 1,
        );
    const template = { ...normalized, version };
    if (existing && preserveVersion) return existing;
    const timestamp = now();
    db.prepare(
      `INSERT INTO orchestration_template_versions
       (id, family, version, name, definition_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, version) DO UPDATE SET
         family = excluded.family,
         name = excluded.name,
         definition_json = excluded.definition_json,
         updated_at = excluded.updated_at`,
    ).run(template.id, template.family, template.version, template.name, JSON.stringify(template.definition), timestamp, timestamp);
    return getTemplate({ templateId: template.id, version: template.version });
  }

  function createHarnessTask(input) {
    const projectId = safeSegment(input?.projectId || "local-project");
    const taskId = safeSegment(input?.taskId || `harness-${randomUUID().slice(0, 8)}`);
    const cwd = path.resolve(requiredString(input?.cwd, "cwd"));
    assertWritableProjectDirectory(cwd);
    const title = requiredString(input?.title || "OpenCode nested workflow harness", "title");
    const goal = requiredString(input?.goal || "Prove a nested Workflow through real OpenCode Sessions.", "goal");
    const model = String(input?.model || DEFAULT_MODEL);
    const blueprint = input?.templateBlueprintId
      ? getTemplateBlueprint({ blueprintId: input.templateBlueprintId, version: input?.templateBlueprintVersion })
      : undefined;
    if (input?.templateBlueprintId && !blueprint) throw new Error("template_blueprint_not_found");
    const loopTemplate = getTemplate({
      templateId: blueprint?.agentLoopTemplate.id || input?.agentLoopTemplateId || AGENT_LOOP_TEMPLATE_ID,
      version: blueprint?.agentLoopTemplate.version || input?.agentLoopTemplateVersion,
    });
    if (!loopTemplate || loopTemplate.family !== "agent_loop") throw new Error("agent_loop_template_not_found");
    const nestedWorkflow = getTemplate({
      templateId: loopTemplate.definition.nestedWorkflow.templateId,
      version: loopTemplate.definition.nestedWorkflow.version,
    });
    if (!nestedWorkflow || nestedWorkflow.family !== "workflow") throw new Error("nested_workflow_template_not_found");
    assertExecutableWorkflowDefinition(nestedWorkflow.definition);

    const existing = db.prepare("SELECT task_id FROM orchestration_harness_tasks WHERE task_id = ?").get(taskId);
    if (existing) throw new Error("harness_task_id_conflict");

    const architectureId = `architecture-${randomUUID()}`;
    const createdAt = now();
    const deliveryContract = createTaskDeliveryContract({ taskId, title, goal, workflowNodes: nestedWorkflow.definition.nodes });
    const architecture = {
      id: architectureId,
      primaryMode: "agent_loop",
      templateBlueprint: blueprint ? templateBlueprintReference(blueprint) : undefined,
      agentLoopTemplate: templateReference(loopTemplate),
      nestedWorkflowTemplate: templateReference(nestedWorkflow),
      sessionPlan: {
        provider: "opencode",
        model,
        conductor: "conductor",
        workflowRoles: nestedWorkflow.definition.nodes.map((node) => ({ id: node.id, role: node.role })),
        // Workflow roles and Loop roles intentionally live in different
        // namespaces. A Workflow node may advance under graph control; a Loop
        // role is always dispatched by Conductor and always returns to it.
        loopRoles: deliveryContract.publisher
          ? [{ id: deliveryContract.publisher.id, role: deliveryContract.publisher.role, kind: "publisher" }]
          : [],
        deliveryContract,
      },
    };
    db.prepare(
      `INSERT INTO orchestration_harness_tasks
       (task_id, project_id, cwd, title, goal, architecture_id, architecture_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(taskId, projectId, cwd, title, goal, architectureId, JSON.stringify(architecture), createdAt, createdAt);
    recordSemanticEvent({
      taskId,
      cwd,
      type: "task.architecture_confirmed",
      summary: `Confirmed ${loopTemplate.name} with nested ${nestedWorkflow.name}.`,
      data: {
        architectureId,
        templateBlueprint: blueprint ? templateBlueprintReference(blueprint) : undefined,
        agentLoopTemplate: templateReference(loopTemplate),
        nestedWorkflowTemplate: templateReference(nestedWorkflow),
        deliveryContract,
      },
    });
    return readTask({ taskId });
  }

  async function generateTemplateDraft(input) {
    const cwd = path.resolve(requiredString(input?.cwd, "cwd"));
    assertWritableProjectDirectory(cwd);
    const title = requiredString(input?.title || "Untitled Task", "title");
    const goal = requiredString(input?.goal, "goal");
    const model = String(input?.model || DEFAULT_MODEL);
    let providerOutput;
    let candidate;
    let lastFailure;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await runOpenCode({
        cwd,
        model,
        message: templateDraftPrompt({ title, goal, attempt }),
      });
      if (!result?.ok) {
        lastFailure = `provider: ${String(result?.stderr || result?.error || "unknown provider error").slice(0, 600)}`;
        continue;
      }
      try {
        providerOutput = extractOpenCodeOutput(result.stdout || "");
        candidate = normalizeGeneratedArchitecture(extractJsonObject(providerOutput.answerText), { title });
        break;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      }
    }
    if (!candidate || !providerOutput) {
      throw new Error(`OpenCode could not generate a valid template draft after 2 attempts: ${lastFailure || "unknown provider error"}`);
    }
    const draftId = `draft-${randomUUID()}`;
    const timestamp = now();
    db.prepare(
      `INSERT INTO orchestration_template_drafts
       (draft_id, cwd, title, goal, model, status, candidate_json, provider_output_json, saved_templates_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'generated', ?, ?, NULL, ?, ?)`,
    ).run(
      draftId,
      cwd,
      title,
      goal,
      model,
      JSON.stringify(candidate),
      JSON.stringify({ answerText: providerOutput.answerText, providerSessionId: providerOutput.providerSessionId }),
      timestamp,
      timestamp,
    );
    return readTemplateDraft({ draftId });
  }

  function readTemplateDraft({ draftId }) {
    const row = db.prepare("SELECT * FROM orchestration_template_drafts WHERE draft_id = ?").get(requiredString(draftId, "draftId"));
    return row ? deserializeTemplateDraft(row) : undefined;
  }

  function saveGeneratedTemplateDraft({ draftId }) {
    const draft = readTemplateDraft({ draftId });
    if (!draft) throw new Error("template_draft_not_found");
    if (draft.status === "saved") return draft;
    const workflow = saveTemplateVersion({
      id: draft.candidate.workflow.id,
      family: "workflow",
      version: 1,
      name: draft.candidate.workflow.name,
      definition: draft.candidate.workflow.definition,
    });
    const agentLoop = saveTemplateVersion({
      id: draft.candidate.agentLoop.id,
      family: "agent_loop",
      version: 1,
      name: draft.candidate.agentLoop.name,
      definition: dynamicLoopDefinition({
        conductor: draft.candidate.agentLoop.definition.conductor,
        nestedWorkflow: { templateId: workflow.id, version: workflow.version },
      }),
    });
    const blueprint = saveTemplateBlueprint({
      id: draft.candidate.blueprint.id,
      version: 1,
      name: draft.candidate.blueprint.name,
      description: draft.candidate.blueprint.description,
      agentLoopTemplate: templateReference(agentLoop),
      workflowTemplate: templateReference(workflow),
      source: draft.status === "manual" ? "manual" : "generated",
    });
    const savedTemplates = {
      agentLoop: templateReference(agentLoop),
      workflow: templateReference(workflow),
      blueprint: templateBlueprintReference(blueprint),
    };
    db.prepare(
      `UPDATE orchestration_template_drafts
       SET status = 'saved', saved_templates_json = ?, updated_at = ? WHERE draft_id = ?`,
    ).run(JSON.stringify(savedTemplates), now(), draft.draftId);
    return readTemplateDraft({ draftId: draft.draftId });
  }

  function createManualTemplateDraft(input) {
    const cwd = path.resolve(requiredString(input?.cwd, "cwd"));
    assertWritableProjectDirectory(cwd);
    const title = requiredString(input?.title, "title");
    const goal = requiredString(input?.goal || input?.description || title, "goal");
    const candidate = normalizeGeneratedArchitecture(
      {
        agentLoop: { name: input?.agentLoop?.name || `${title} Agent Loop`, conductorRole: input?.agentLoop?.conductorRole || "Conductor" },
        workflow: { name: input?.workflow?.name || `${title} Workflow`, nodes: input?.workflow?.nodes },
        rationale: input?.rationale || "Hand-built in Template Builder.",
        assumptions: input?.assumptions || [],
      },
      { title, description: input?.description },
    );
    const draftId = `draft-${randomUUID()}`;
    const timestamp = now();
    db.prepare(
      `INSERT INTO orchestration_template_drafts
       (draft_id, cwd, title, goal, model, status, candidate_json, provider_output_json, saved_templates_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'manual', ?, '{}', NULL, ?, ?)`,
    ).run(draftId, cwd, title, goal, String(input?.model || DEFAULT_MODEL), JSON.stringify(candidate), timestamp, timestamp);
    return readTemplateDraft({ draftId });
  }

  async function startHarnessRun({ taskId }) {
    const task = taskFor(taskId);
    if (!task) throw new Error("harness_task_not_found");
    if (task.status === "achieved") throw new Error("harness_task_achieved");
    const active = db
      .prepare("SELECT run_id FROM orchestration_harness_runs WHERE task_id = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1")
      .get(task.taskId);
    if (active) return readRun({ runId: active.run_id });

    const runId = `run-${randomUUID()}`;
    const loopInstanceId = `agent-loop-${randomUUID()}`;
    const workflowInstanceId = `workflow-${randomUUID()}`;
    const loopTemplate = getTemplate({ templateId: task.architecture.agentLoopTemplate.id, version: task.architecture.agentLoopTemplate.version });
    const workflowTemplate = getTemplate({
      templateId: task.architecture.nestedWorkflowTemplate.id,
      version: task.architecture.nestedWorkflowTemplate.version,
    });
    if (!loopTemplate || !workflowTemplate) throw new Error("harness_template_provenance_missing");
    assertExecutableWorkflowDefinition(workflowTemplate.definition);
    const correctionBudget = correctionRoundBudget(loopTemplate.definition);
    const timestamp = now();

    transaction(db, () => {
      db.prepare(
        `INSERT INTO orchestration_harness_runs
         (run_id, task_id, architecture_id, status, agent_loop_instance_id, workflow_instance_id, created_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`,
      ).run(runId, task.taskId, task.architecture.id, loopInstanceId, workflowInstanceId, timestamp, timestamp);
      db.prepare(
        `INSERT INTO orchestration_harness_instances
         (instance_id, run_id, kind, parent_instance_id, template_id, template_version, status, phase, details_json, created_at, updated_at)
         VALUES (?, ?, 'agent_loop', NULL, ?, ?, 'running', 'initial_conductor', ?, ?, ?)`,
      ).run(
        loopInstanceId,
        runId,
        loopTemplate.id,
        loopTemplate.version,
        JSON.stringify({ nestedWorkflowInstanceId: workflowInstanceId, correctionRound: 0, maxCorrectionRounds: correctionBudget }),
        timestamp,
        timestamp,
      );
      db.prepare(
        `INSERT INTO orchestration_harness_instances
         (instance_id, run_id, kind, parent_instance_id, template_id, template_version, status, phase, details_json, created_at, updated_at)
         VALUES (?, ?, 'workflow', ?, ?, ?, 'pending', 'pending', '{}', ?, ?)`,
      ).run(workflowInstanceId, runId, loopInstanceId, workflowTemplate.id, workflowTemplate.version, timestamp, timestamp);
      for (const node of workflowTemplate.definition.nodes) {
        db.prepare(
          `INSERT INTO orchestration_harness_nodes
           (instance_id, node_id, role, dependencies_json, status, details_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', '{}', ?, ?)`,
        ).run(workflowInstanceId, node.id, node.role, JSON.stringify(node.dependsOn), timestamp, timestamp);
      }
      db.prepare("UPDATE orchestration_harness_tasks SET status = 'running', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    });

    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      type: "task.run.started",
      summary: "Agent Loop Run started; initial Conductor decision is running.",
      data: { runId, loopInstanceId, workflowInstanceId },
    });
    try {
      await startConductorTurn({ task, runId, loopInstanceId, workflowInstanceId, purpose: "initial" });
    } catch (error) {
      failRun({ task, run: runFor(runId), reason: "initial_conductor_start_failed" });
      throw error;
    }
    return readRun({ runId });
  }

  async function handlePtyEvent(event) {
    if (event?.type !== "exit" || !event.id) return { handled: false, reason: "not_an_exit" };
    const turn = db
      .prepare(
        `SELECT * FROM orchestration_harness_turns
         WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(String(event.id));
    if (!turn) return { handled: false, reason: "not_a_harness_turn" };
    const task = taskForRun(turn.run_id);
    if (!task) return { handled: false, reason: "task_not_found" };
    const terminal = ptyManager.read(turn.session_id, 0);
    const transcript = Array.isArray(terminal?.transcript) ? terminal.transcript.join("") : "";
    const output = {
      ...extractOpenCodeOutput(transcript),
      artifacts: detectArtifacts({ cwd: task.cwd, before: JSON.parse(turn.details_json || "{}").artifactSnapshot }),
    };
    const completed = Number(event.exitCode ?? terminal?.exitCode ?? 0) === 0 && Boolean(output.answerText);
    return finishTurn({ task, turn, output, completed, exitCode: event.exitCode ?? terminal?.exitCode ?? null, stopNativeTui: false });
  }

  async function finishTurn({ task, turn, output, completed, exitCode = null, stopNativeTui }) {
    const timestamp = now();
    db.prepare(
      `UPDATE orchestration_harness_turns
       SET status = ?, output_json = ?, completed_at = ?, updated_at = ? WHERE turn_id = ?`,
    ).run(completed ? "succeeded" : "failed", JSON.stringify({ ...output, exitCode }), timestamp, timestamp, turn.turn_id);
    openCodeHookService?.clearSession?.(turn.session_id);

    if (stopNativeTui) {
      const terminal = ptyManager.read(turn.session_id, 0);
      if (terminal?.incarnationId) {
        try {
          sessionAuthority.stopSession({ workspaceSessionId: turn.session_id, expectedIncarnationId: terminal.incarnationId });
        } catch {
          // The answer is already durable. A naturally exiting TUI may race this cleanup.
        }
      }
    }

    if (!completed && (await retryFailedTurn({ task, turn, output }))) {
      return { handled: true, runId: turn.run_id, turnId: turn.turn_id, completed: false, retrying: true };
    }

    if (turn.purpose === "initial") {
      await completeInitialConductor({ task, turn, output, completed });
    } else if (turn.purpose === "workflow_node") {
      await completeWorkflowNode({ task, turn, output, completed });
    } else if (turn.purpose === "remediation") {
      await completeRemediation({ task, turn, output, completed });
    } else if (turn.purpose === "remediation_verify") {
      await completeRemediationVerify({ task, turn, output, completed });
    } else if (turn.purpose === "workflow_return" || turn.purpose === "session_return") {
      await completeWorkflowReturnConductor({ task, turn, output, completed });
    }
    return { handled: true, runId: turn.run_id, turnId: turn.turn_id, completed };
  }

  async function handleOpenCodeHookEvent(event) {
    const sessionId = requiredString(event?.sessionId, "hook sessionId");
    const kind = String(event?.kind ?? "");
    const turn = db
      .prepare(
        `SELECT * FROM orchestration_harness_turns
         WHERE session_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId);
    if (!turn) return { handled: false, reason: "not_a_running_harness_turn" };
    const task = taskForRun(turn.run_id);
    if (!task) return { handled: false, reason: "task_not_found" };

    if (kind === "message") {
      if (String(event?.payload?.role ?? "") !== "assistant" || !String(event?.payload?.text ?? "").trim()) {
        return { handled: true, kind, sessionId, ignored: true };
      }
      const details = JSON.parse(turn.details_json || "{}");
      db.prepare("UPDATE orchestration_harness_turns SET details_json = ?, updated_at = ? WHERE turn_id = ?").run(
        JSON.stringify({ ...details, assistantText: String(event.payload.text).slice(0, 60_000), providerSessionId: event.payload.sessionID ?? details.providerSessionId }),
        now(),
        turn.turn_id,
      );
      return { handled: true, kind, sessionId };
    }

    if (kind === "status") {
      if (String(event?.payload?.type ?? "") === "busy") {
        const changed = db.prepare(
          `UPDATE orchestration_harness_attentions
           SET status = 'resolved', resolved_at = ?, updated_at = ?
           WHERE turn_id = ? AND status IN ('pending', 'submitted')`,
        ).run(now(), now(), turn.turn_id).changes;
        if (changed) {
          recordHarnessEvent({ runId: turn.run_id, type: "session.attention.resolved", summary: "OpenCode resumed after user attention.", data: { sessionId } });
          recordSemanticEvent({
            taskId: task.taskId,
            cwd: task.cwd,
            sessionId,
            type: "session.attention.resolved",
            summary: "OpenCode 已继续执行。",
            data: { runId: turn.run_id },
          });
        }
      }
      if (String(event?.payload?.type ?? "") === "idle") {
        const details = JSON.parse(turn.details_json || "{}");
        const answerText = String(details.assistantText ?? "").trim();
        if (answerText) {
          const output = {
            answerText,
            errorText: "",
            providerSessionId: details.providerSessionId,
            completedAt: Date.now(),
            source: "opencode-hook-message",
            artifacts: detectArtifacts({ cwd: task.cwd, before: details.artifactSnapshot }),
          };
          return finishTurn({ task, turn, output, completed: true, stopNativeTui: true });
        }
      }
      return { handled: true, kind, sessionId };
    }
    if (kind !== "permission" && kind !== "question") return { handled: false, reason: "hook_kind_ignored" };

    const existing = db
      .prepare(
        `SELECT attention_id FROM orchestration_harness_attentions
         WHERE turn_id = ? AND kind = ? AND status IN ('pending', 'submitted')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(turn.turn_id, kind);
    const attentionId = existing?.attention_id ?? `attention-${randomUUID()}`;
    const payload = sanitizeHookPayload(event?.payload);
    const timestamp = now();
    db.prepare(
      `INSERT INTO orchestration_harness_attentions
       (attention_id, run_id, turn_id, session_id, kind, status, payload_json, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL)
       ON CONFLICT(attention_id) DO UPDATE SET
         status = 'pending', payload_json = excluded.payload_json, updated_at = excluded.updated_at, resolved_at = NULL`,
    ).run(attentionId, turn.run_id, turn.turn_id, sessionId, kind, JSON.stringify(payload), timestamp, timestamp);
    recordHarnessEvent({
      runId: turn.run_id,
      type: kind === "permission" ? "session.permission.requested" : "session.question.asked",
      summary: kind === "permission" ? "OpenCode requested a permission decision." : "OpenCode requested user input.",
      data: { attentionId, sessionId, turnId: turn.turn_id, kind, payload },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId,
      type: kind === "permission" ? "session.permission.requested" : "session.question.asked",
      summary: kind === "permission" ? "OpenCode 正在等待权限决定。" : "OpenCode 正在等待你的回答。",
      data: { runId: turn.run_id, attentionId, kind },
    });
    return { handled: true, runId: turn.run_id, attentionId, kind };
  }

  async function respondToAttention({ attentionId, response }) {
    const row = db.prepare("SELECT * FROM orchestration_harness_attentions WHERE attention_id = ?").get(requiredString(attentionId, "attentionId"));
    if (!row) throw new Error("harness_attention_not_found");
    const attention = deserializeAttention(row);
    if (!new Set(["pending", "submitted"]).has(attention.status)) throw new Error("harness_attention_not_pending");
    const turn = db.prepare("SELECT * FROM orchestration_harness_turns WHERE turn_id = ?").get(attention.turnId);
    if (!turn || turn.status !== "running") throw new Error("harness_attention_session_not_running");
    const task = taskForRun(attention.runId);
    if (!task) throw new Error("harness_attention_task_not_found");
    const terminal = ptyManager.read(attention.sessionId, 0);
    const incarnationId = terminal?.incarnationId;
    if (!incarnationId) throw new Error("harness_attention_terminal_not_active");
    const answer = requiredString(response, "attention response");
    await sessionAuthority.enqueueInput({
      workspaceSessionId: attention.sessionId,
      expectedIncarnationId: incarnationId,
      source: attention.kind === "permission" ? "permission_reply" : "user",
      payload: answer.endsWith("\r") || answer.endsWith("\n") ? answer : `${answer}\r`,
      idempotencyKey: `attention:${attention.attentionId}:${crypto.createHash("sha256").update(answer).digest("base64url")}`,
    });
    db.prepare("UPDATE orchestration_harness_attentions SET status = 'submitted', updated_at = ? WHERE attention_id = ?").run(now(), attention.attentionId);
    recordHarnessEvent({ runId: attention.runId, type: "session.attention.responded", summary: "User response was sent to the active OpenCode PTY.", data: { attentionId: attention.attentionId, sessionId: attention.sessionId, kind: attention.kind } });
    recordSemanticEvent({ taskId: task.taskId, cwd: task.cwd, sessionId: attention.sessionId, type: "session.attention.responded", summary: "你的回答已写入对应 OpenCode Session。", data: { runId: attention.runId, attentionId: attention.attentionId, kind: attention.kind } });
    return readRun({ runId: attention.runId });
  }

  function listHarnessTasks() {
    return db
      .prepare(
        `SELECT task_id, project_id, cwd, title, goal, architecture_id, architecture_json, status, created_at, updated_at
         FROM orchestration_harness_tasks
         ORDER BY CASE status
           WHEN 'running' THEN 0
           WHEN 'queued' THEN 1
           WHEN 'delivery_ready' THEN 2
           WHEN 'blocked' THEN 3
           WHEN 'achieved' THEN 4
           ELSE 5
         END, updated_at DESC`,
      )
      .all()
      .map(deserializeTask)
      .map((task) => ({ ...task, latestRun: latestRunForTask(task.taskId) }));
  }

  function readTask({ taskId }) {
    const task = taskFor(taskId);
    return task ? { ...task, latestRun: latestRunForTask(task.taskId) } : undefined;
  }

  function readRun({ runId }) {
    const run = runFor(runId);
    if (!run) return undefined;
    const task = taskFor(run.taskId);
    const instances = db
      .prepare("SELECT * FROM orchestration_harness_instances WHERE run_id = ? ORDER BY created_at ASC")
      .all(run.runId)
      .map(deserializeInstance);
    const workflow = instances.find((instance) => instance.kind === "workflow");
    const storedNodes = workflow
      ? db
          .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
          .all(workflow.instanceId)
          .map(deserializeNode)
      : [];
    const workflowTemplate = workflow
      ? getTemplate({ templateId: workflow.templateId, version: workflow.templateVersion })
      : undefined;
    const definitionByNodeId = new Map((workflowTemplate?.definition?.nodes ?? []).map((node) => [node.id, node]));
    const nodes = storedNodes.map((node) => ({
      ...node,
      instruction: definitionByNodeId.get(node.nodeId)?.instruction,
      kind: definitionByNodeId.get(node.nodeId)?.kind,
    }));
    const turns = db
      .prepare("SELECT * FROM orchestration_harness_turns WHERE run_id = ? ORDER BY started_at ASC")
      .all(run.runId)
      .map(deserializeTurn)
      .map((turn) => ({ ...turn, terminal: ptyManager.read(turn.sessionId, 0) }));
    const events = db
      .prepare("SELECT * FROM orchestration_harness_events WHERE run_id = ? ORDER BY sequence ASC")
      .all(run.runId)
      .map(deserializeHarnessEvent);
    const attentions = db
      .prepare("SELECT * FROM orchestration_harness_attentions WHERE run_id = ? ORDER BY created_at ASC")
      .all(run.runId)
      .map(deserializeAttention);
    return { task, run, instances, workflow, nodes, turns, artifacts: listRunArtifacts({ task, turns }), attentions, events };
  }

  function readArtifact({ runId, artifactPath }) {
    const detail = readRun({ runId });
    if (!detail) return undefined;
    const requested = requiredArtifactPath(artifactPath);
    const artifact = detail.artifacts.find((item) => item.path === requested);
    if (!artifact) throw new Error("harness_artifact_not_found");
    return readArtifactFile({ cwd: detail.task.cwd, artifact });
  }

  function markTaskAchieved({ taskId }) {
    const task = taskFor(taskId);
    if (!task) throw new Error("harness_task_not_found");
    if (task.status === "achieved") return task;
    if (task.status !== "delivery_ready") throw new Error("harness_task_not_ready_to_achieve");
    const run = latestRunForTask(task.taskId);
    const timestamp = now();
    db.prepare("UPDATE orchestration_harness_tasks SET status = 'achieved', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      type: "task.achieved",
      summary: "用户已确认交付文件，Task 进入 achieved 历史。",
      data: { runId: run?.runId, artifacts: run ? listRunArtifacts({ task, turns: db.prepare("SELECT * FROM orchestration_harness_turns WHERE run_id = ? ORDER BY started_at ASC").all(run.runId).map(deserializeTurn) }) : [] },
    });
    if (run) recordHarnessEvent({ runId: run.runId, type: "task.achieved", summary: "User marked the delivered artifacts as achieved.", data: { taskId: task.taskId } });
    return taskFor(task.taskId);
  }

  function close() {
    db.close();
  }

  async function completeInitialConductor({ task, turn, output, completed }) {
    const run = runFor(turn.run_id);
    if (!run) return;
    const workflow = instanceFor(run.workflowInstanceId);
    const context = remediationContext({ task, run });
    const decision = normalizeConductorDecision({
      answerText: output.answerText,
      phase: "initial",
      workflowStatus: workflow?.status ?? "pending",
      nodeIds: context.dispatchTargetIds,
      verifierPassed: context.verifierPassed,
      requiresArtifact: taskRequiresArtifact(task.goal),
      artifacts: context.artifacts,
      deliveryContract: taskDeliveryContract(task),
    });
    const presentedOutput = presentConductorOutput({ output, decision });
    db.prepare("UPDATE orchestration_harness_turns SET output_json = ?, updated_at = ? WHERE turn_id = ?").run(
      JSON.stringify(presentedOutput),
      now(),
      turn.turn_id,
    );
    recordHarnessEvent({
      runId: run.runId,
      type: completed ? "conductor.decision" : "conductor.failed",
      summary: completed ? `Conductor selected ${decision.action}.` : "Initial Conductor Session failed.",
      data: { sessionId: turn.session_id, action: decision.action, answerPreview: presentedOutput.answerText.slice(0, 500) },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: completed ? "conductor.decision" : "conductor.failed",
      summary: completed ? `Conductor decision: ${decision.action}.` : "Conductor initial decision failed.",
      data: { runId: run.runId, sessionId: turn.session_id, action: decision.action, answerPreview: presentedOutput.answerText.slice(0, 500) },
    });
    if (!completed) return failRun({ task, run, reason: "initial_conductor_failed" });
    await applyConductorDecision({ task, run, turn, decision, source: "task.started" });
  }

  async function launchBoundedWorkflow({ task, run, source, turn }) {
    const workflow = instanceFor(run.workflowInstanceId);
    if (!workflow || workflow.status !== "pending") {
      return finishDelivery({
        task,
        run,
        turn,
        output: { ...turn.output, answerText: "## 无法继续\n当前 Template 只支持一个受限 Workflow 实例；Conductor 必须先处理现有返回。" },
        status: "blocked",
        reason: "workflow_round_not_available",
      });
    }
    db.prepare("UPDATE orchestration_harness_instances SET phase = 'workflow_running', updated_at = ? WHERE instance_id = ?").run(
      now(),
      run.agentLoopInstanceId,
    );
    db.prepare("UPDATE orchestration_harness_instances SET status = 'running', phase = 'running', updated_at = ? WHERE instance_id = ?").run(
      now(),
      run.workflowInstanceId,
    );
    recordHarnessEvent({
      runId: run.runId,
      type: "workflow.created",
      summary: "Conductor started the bounded Workflow execution unit.",
      data: { workflowInstanceId: run.workflowInstanceId, source, sessionId: turn.session_id },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      type: "workflow.created",
      summary: "Conductor 启动了一个受限 Workflow 执行单元。",
      data: { runId: run.runId, workflowInstanceId: run.workflowInstanceId, source },
    });
    return advanceWorkflow({ task, run });
  }

  async function completeWorkflowNode({ task, turn, output, completed }) {
    const run = runFor(turn.run_id);
    if (!run || !turn.node_id) return;
    const status = completed ? "succeeded" : "failed";
    db.prepare(
      `UPDATE orchestration_harness_nodes
       SET status = ?, output_json = ?, updated_at = ? WHERE instance_id = ? AND node_id = ?`,
    ).run(status, JSON.stringify(output), now(), run.workflowInstanceId, turn.node_id);
    recordHarnessEvent({
      runId: run.runId,
      type: completed ? "workflow.node.succeeded" : "workflow.node.failed",
      summary: `Workflow node ${turn.node_id} ${status}.`,
      data: { nodeId: turn.node_id, sessionId: turn.session_id, answerPreview: output.answerText.slice(0, 500) },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: completed ? "workflow.node.succeeded" : "workflow.node.failed",
      summary: `Workflow ${turn.node_id} ${status}.`,
      data: { runId: run.runId, workflowInstanceId: run.workflowInstanceId, nodeId: turn.node_id, sessionId: turn.session_id },
    });
    if (!completed) return completeWorkflow({ task, run, status: "failed" });
    await advanceWorkflow({ task, run });
  }

  async function advanceWorkflow({ task, run }) {
    const workflow = instanceFor(run.workflowInstanceId);
    if (!workflow || workflow.status !== "running") return;
    const nodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
      .all(workflow.instanceId)
      .map(deserializeNode);
    if (nodes.some((node) => node.status === "failed" || node.status === "blocked")) {
      return completeWorkflow({ task, run, status: "failed" });
    }
    const running = nodes.filter((node) => node.status === "running").length;
    const ready = nodes.filter((node) => node.status === "pending" && node.dependencies.every((id) => nodes.some((item) => item.nodeId === id && item.status === "succeeded")));
    const capacity = Math.max(0, maxConcurrentWorkflowSessions - running);
    if (ready.length && capacity > 0) {
      return Promise.all(ready.slice(0, capacity).map((node) => startWorkflowNode({ task, run, node })));
    }
    if (nodes.length > 0 && nodes.every((node) => node.status === "succeeded")) {
      return completeWorkflow({ task, run, status: "succeeded" });
    }
  }

  async function completeWorkflow({ task, run, status }) {
    const timestamp = now();
    db.prepare("UPDATE orchestration_harness_instances SET status = ?, phase = 'final', updated_at = ? WHERE instance_id = ?").run(
      status,
      timestamp,
      run.workflowInstanceId,
    );
    const nodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
      .all(run.workflowInstanceId)
      .map(deserializeNode);
    const summary = workflowSummary(nodes);
    recordHarnessEvent({
      runId: run.runId,
      type: status === "succeeded" ? "workflow.completed" : "workflow.failed",
      summary: status === "succeeded" ? "Nested Workflow completed; returning to Conductor." : "Nested Workflow failed; returning exception to Conductor.",
      data: { workflowInstanceId: run.workflowInstanceId, status, summary },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      type: status === "succeeded" ? "workflow.completed" : "workflow.failed",
      summary: status === "succeeded" ? "Workflow final: return to Conductor." : "Workflow exception: return to Conductor.",
      data: { runId: run.runId, workflowInstanceId: run.workflowInstanceId, status },
    });
    await startConductorTurn({ task, runId: run.runId, loopInstanceId: run.agentLoopInstanceId, workflowInstanceId: run.workflowInstanceId, purpose: "workflow_return", workflowStatus: status, workflowSummary: summary });
  }

  async function completeWorkflowReturnConductor({ task, turn, output, completed }) {
    const run = runFor(turn.run_id);
    if (!run) return;
    const workflowStatus = instanceFor(run.workflowInstanceId)?.status ?? "failed";
    const context = remediationContext({ task, run });
    const decision = normalizeConductorDecision({
      answerText: output.answerText,
      phase: turn.purpose === "session_return" ? "session_return" : "workflow_return",
      workflowStatus,
      nodeIds: context.dispatchTargetIds,
      verifierPassed: context.verifierPassed,
      requiresArtifact: taskRequiresArtifact(task.goal),
      artifacts: context.artifacts,
      deliveryContract: taskDeliveryContract(task),
    });
    const presentedOutput = presentConductorOutput({ output, decision });
    db.prepare("UPDATE orchestration_harness_turns SET output_json = ?, updated_at = ? WHERE turn_id = ?").run(
      JSON.stringify(presentedOutput),
      now(),
      turn.turn_id,
    );
    recordHarnessEvent({
      runId: run.runId,
      type: completed ? "conductor.decision" : "conductor.failed",
      summary: completed ? `Conductor selected ${decision.action} after ${turn.purpose}.` : "Conductor could not process the Runtime return.",
      data: { sessionId: turn.session_id, source: turn.purpose, action: decision.action, answerPreview: presentedOutput.answerText.slice(0, 500) },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: completed ? "conductor.decision" : "conductor.failed",
      summary: completed ? `Conductor 根据 ${turn.purpose} 选择 ${decision.action}。` : "Conductor 未能处理 Runtime 返回。",
      data: { runId: run.runId, source: turn.purpose, action: decision.action },
    });

    if (!completed || decision.action === "block") {
      return finishDelivery({
        task,
        run,
        turn,
        output: presentedOutput,
        status: "blocked",
        reason: completed ? "conductor_blocked" : "conductor_return_failed",
      });
    }

    if (decision.action === "deliver") {
      return finishDelivery({ task, run, turn, output: presentedOutput, status: "delivery_ready" });
    }

    await applyConductorDecision({
      task,
      run,
      turn,
      decision,
      source: turn.purpose === "session_return" ? "session.return" : "workflow.return",
      context,
    });
  }

  async function applyConductorDecision({ task, run, turn, decision, source, context = remediationContext({ task, run }) }) {
    if (decision.action === "launch_workflow") {
      return launchBoundedWorkflow({ task, run, source, turn });
    }

    if (decision.action === "verify") {
      const correctionRound = Number(instanceFor(run.agentLoopInstanceId)?.details?.correctionRound ?? 0);
      recordHarnessEvent({
        runId: run.runId,
        type: "conductor.verify",
        summary: "Conductor requested a focused verification Session.",
        data: { sessionId: turn.session_id, correctionRound, source },
      });
      return startRemediationVerify({
        task,
        run,
        correctionRound,
        remediationTurns: loopDispatchTurns({ runId: run.runId, correctionRound }),
      });
    }

    if (decision.action !== "dispatch" || !decision.remediations.length) {
      return finishDelivery({
        task,
        run,
        turn,
        output: { ...turn.output, answerText: "## 无法继续\nConductor 没有给出可执行的下一步，Runtime 已保留证据。" },
        status: "blocked",
        reason: "conductor_action_invalid",
      });
    }

    const loop = instanceFor(run.agentLoopInstanceId);
    const currentRound = Number(loop?.details?.correctionRound ?? 0);
    const maxCorrectionRounds = Number(loop?.details?.maxCorrectionRounds ?? MAX_CORRECTION_ROUNDS);
    if (currentRound >= maxCorrectionRounds) {
      return finishDelivery({
        task,
        run,
        turn,
        output: {
          ...presentedOutput,
          answerText: `${presentedOutput.answerText}\n\n## Runtime 停止\n修复轮次已达到模板预算 ${maxCorrectionRounds}，保留全部产物和证据，未把问题转交给人工中继。`,
        },
        status: "blocked",
        reason: "correction_budget_exhausted",
      });
    }

    const correctionRound = currentRound + 1;
    db.prepare("UPDATE orchestration_harness_instances SET phase = 'remediating', details_json = ?, updated_at = ? WHERE instance_id = ?").run(
      JSON.stringify({ ...(loop?.details ?? {}), correctionRound }),
      now(),
      run.agentLoopInstanceId,
    );
    recordHarnessEvent({
      runId: run.runId,
      type: "conductor.dispatch",
      summary: `Conductor dispatched ${decision.remediations[0].nodeId}; Runtime will wake it again after this Session returns.`,
      data: { sessionId: turn.session_id, correctionRound, source, remediation: decision.remediations[0] },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: "conductor.dispatch",
      summary: `Conductor 派发第 ${correctionRound} 轮的一个明确修复任务。`,
      data: { runId: run.runId, correctionRound, source, remediation: decision.remediations[0] },
    });
    return startRemediationTurn({
      task,
      run,
      remediation: decision.remediations[0],
      correctionRound,
      verifierSummary: context.verifierSummary,
    });
  }

  function remediationContext({ task, run }) {
    const workflow = instanceFor(run.workflowInstanceId);
    const template = workflow ? getTemplate({ templateId: workflow.templateId, version: workflow.templateVersion }) : undefined;
    const nodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
      .all(run.workflowInstanceId)
      .map(deserializeNode);
    const turns = db.prepare("SELECT * FROM orchestration_harness_turns WHERE run_id = ? ORDER BY started_at ASC").all(run.runId).map(deserializeTurn);
    const verifyNode = template?.definition?.nodes?.find((node) => node.kind === "verify");
    const verificationTurn = turns
      .filter((item) => (item.purpose === "workflow_node" || item.purpose === "remediation_verify") && item.nodeId === verifyNode?.id)
      .at(-1);
    const verifierSummary = verificationTurn?.output?.answerText ?? nodes.find((node) => node.nodeId === verifyNode?.id)?.output?.answerText ?? "";
    const workflowDispatchTargets = (template?.definition?.nodes ?? [])
      .filter((node) => node.kind !== "verify")
      .map((node) => node.id);
    const loopDispatchTargets = loopDispatchTargetsForTask(task).map((role) => role.id);
    return {
      verifierSummary,
      verifierPassed: isVerificationPass(verifierSummary),
      // A source/synthesis repair is a Conductor-owned Loop Session, even
      // though it reuses the role contract from a Workflow node. Publisher is
      // a Loop-only role and never appears as a Workflow node.
      dispatchTargetIds: [...workflowDispatchTargets, ...loopDispatchTargets],
      artifacts: listRunArtifacts({ task, turns }),
    };
  }

  function loopDispatchTurns({ runId, correctionRound }) {
    return db
      .prepare("SELECT * FROM orchestration_harness_turns WHERE run_id = ? AND purpose = 'remediation' ORDER BY started_at ASC")
      .all(runId)
      .map(deserializeTurn)
      .filter((item) => Number(item.details?.correctionRound ?? 0) === Number(correctionRound));
  }

  function finishDelivery({ task, run, turn, output, status, reason }) {
    const timestamp = now();
    const delivered = status === "delivery_ready";
    const artifacts = listRunArtifacts({
      task,
      turns: db.prepare("SELECT * FROM orchestration_harness_turns WHERE run_id = ? ORDER BY started_at ASC").all(run.runId).map(deserializeTurn),
    });
    transaction(db, () => {
      db.prepare("UPDATE orchestration_harness_instances SET status = ?, phase = 'complete', updated_at = ? WHERE instance_id = ?").run(
        delivered ? "succeeded" : "failed",
        timestamp,
        run.agentLoopInstanceId,
      );
      db.prepare("UPDATE orchestration_harness_runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, timestamp, run.runId);
      db.prepare("UPDATE orchestration_harness_tasks SET status = ?, updated_at = ? WHERE task_id = ?").run(status, timestamp, task.taskId);
    });
    recordHarnessEvent({
      runId: run.runId,
      type: delivered ? "conductor.deliver" : "conductor.blocked",
      summary: delivered ? "Conductor verified delivery artifacts; task is ready to inspect." : `Conductor blocked the Agent Loop: ${reason ?? "unknown_reason"}.`,
      data: { sessionId: turn.session_id, finalStatus: status, artifacts, reason },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: delivered ? "conductor.deliver" : "conductor.blocked",
      summary: delivered ? "验证通过，交付产物已就绪。" : "Agent Loop 无法继续，已保留失败证据。",
      data: { runId: run.runId, finalStatus: status, reason },
    });
  }

  async function completeRemediation({ task, turn, output, completed }) {
    const run = runFor(turn.run_id);
    if (!run) return;
    const correctionRound = Number(JSON.parse(turn.details_json || "{}").correctionRound ?? 0);
    recordHarnessEvent({
      runId: run.runId,
      type: completed ? "agent_loop.session_return" : "agent_loop.session_failed",
      summary: completed
        ? `${turn.node_id} returned to Conductor for the next decision.`
        : `${turn.node_id} failed and returned to Conductor for a recovery decision.`,
      data: { nodeId: turn.node_id, sessionId: turn.session_id, correctionRound, artifacts: output.artifacts ?? [] },
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: completed ? "agent_loop.session_return" : "agent_loop.session_failed",
      summary: completed ? `${turn.node_id} 已返回给 Conductor 决策。` : `${turn.node_id} 失败，已返回给 Conductor 决策。`,
      data: { runId: run.runId, nodeId: turn.node_id, correctionRound },
    });
    const nodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
      .all(run.workflowInstanceId)
      .map(deserializeNode);
    const summary = [
      workflowSummary(nodes),
      `Session return (${turn.node_id}, ${completed ? "succeeded" : "failed"}):`,
      output.answerText || output.errorText || "The provider produced no usable result.",
      (output.artifacts ?? []).length ? `Runtime-observed changed artifacts: ${(output.artifacts ?? []).map((item) => item.path).join(", ")}` : "Runtime observed no changed artifacts.",
    ].join("\n\n");
    recordHarnessEvent({
      runId: run.runId,
      type: "conductor.wakeup",
      summary: `Runtime woke Conductor after ${turn.node_id} returned.`,
      data: { sessionId: turn.session_id, nodeId: turn.node_id, correctionRound, completed },
    });
    return startConductorTurn({
      task,
      runId: run.runId,
      loopInstanceId: run.agentLoopInstanceId,
      workflowInstanceId: run.workflowInstanceId,
      purpose: "session_return",
      workflowStatus: instanceFor(run.workflowInstanceId)?.status ?? "succeeded",
      workflowSummary: summary,
      previousTurnId: turn.turn_id,
      correctionRound,
    });
  }

  async function completeRemediationVerify({ task, turn, output, completed }) {
    const run = runFor(turn.run_id);
    if (!run) return;
    const correctionRound = Number(JSON.parse(turn.details_json || "{}").correctionRound ?? 0);
    recordHarnessEvent({
      runId: run.runId,
      type: completed ? "agent_loop.session_return" : "agent_loop.session_failed",
      summary: completed
        ? `Verification returned to Conductor after correction round ${correctionRound}.`
        : `Verification failed and returned to Conductor after correction round ${correctionRound}.`,
      data: { sessionId: turn.session_id, correctionRound, answerPreview: output.answerText.slice(0, 500) },
    });
    const workflow = instanceFor(run.workflowInstanceId);
    const nodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
      .all(run.workflowInstanceId)
      .map(deserializeNode);
    const summary = `${workflowSummary(nodes)}\n\nVerification return (${completed ? "succeeded" : "failed"}) for correction round ${correctionRound}:\n${output.answerText || output.errorText || "no result"}`;
    recordHarnessEvent({
      runId: run.runId,
      type: "conductor.wakeup",
      summary: "Runtime woke Conductor after the verification Session returned.",
      data: { sessionId: turn.session_id, correctionRound, completed },
    });
    await startConductorTurn({
      task,
      runId: run.runId,
      loopInstanceId: run.agentLoopInstanceId,
      workflowInstanceId: run.workflowInstanceId,
      purpose: "session_return",
      workflowStatus: workflow?.status ?? "succeeded",
      workflowSummary: summary,
      previousTurnId: turn.turn_id,
      correctionRound,
    });
  }

  async function startConductorTurn({
    task,
    runId,
    loopInstanceId,
    workflowInstanceId,
    purpose,
    workflowStatus,
    workflowSummary: summary,
    attempt = 1,
    previousTurnId,
    correctionRound,
  }) {
    const sessionId = workspaceSessionId(task.projectId, task.taskId, "conductor");
    const workflow = instanceFor(workflowInstanceId);
    const workflowTemplate = workflow
      ? getTemplate({ templateId: workflow.templateId, version: workflow.templateVersion })
      : undefined;
    const prompt =
      purpose === "initial"
        ? initialConductorPrompt(task, workflowTemplate?.definition)
        : finalConductorPrompt(task, {
            workflowStatus,
            workflowSummary: summary,
            dispatchTargets: loopDispatchTargetsForTask(task, workflowTemplate?.definition),
            deliveryContract: taskDeliveryContract(task),
          });
    return startOpenCodeTurn({
      task,
      runId,
      instanceId: loopInstanceId,
      sessionId,
      purpose,
      prompt,
      attempt,
      details: { workflowInstanceId, workflowStatus, previousTurnId, correctionRound },
    });
  }

  async function startWorkflowNode({ task, run, node, attempt = 1, previousTurnId }) {
    const workflow = instanceFor(run.workflowInstanceId);
    const workflowTemplate = workflow
      ? getTemplate({ templateId: workflow.templateId, version: workflow.templateVersion })
      : undefined;
    const definition = workflowTemplate.definition.nodes.find((item) => item.id === node.nodeId);
    if (!definition) throw new Error("workflow_node_definition_missing");
    const completedNodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ?")
      .all(run.workflowInstanceId)
      .map(deserializeNode);
    const prompt = workflowNodePrompt(task, definition, completedNodes);
    const sessionId = workspaceSessionId(task.projectId, task.taskId, `workflow-${node.nodeId}`);
    db.prepare("UPDATE orchestration_harness_nodes SET status = 'running', updated_at = ? WHERE instance_id = ? AND node_id = ?").run(
      now(),
      run.workflowInstanceId,
      node.nodeId,
    );
    recordHarnessEvent({ runId: run.runId, type: "workflow.node.started", summary: `Workflow node ${node.nodeId} started.`, data: { nodeId: node.nodeId, sessionId } });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId,
      type: "workflow.node.started",
      summary: `Workflow node ${node.nodeId} started in OpenCode Session.`,
      data: { runId: run.runId, workflowInstanceId: run.workflowInstanceId, nodeId: node.nodeId, sessionId },
    });
    return startOpenCodeTurn({
      task,
      runId: run.runId,
      instanceId: run.workflowInstanceId,
      nodeId: node.nodeId,
      sessionId,
      purpose: "workflow_node",
      prompt,
      attempt,
      details: { role: node.role, previousTurnId },
    });
  }

  async function startRemediationTurn({ task, run, remediation, correctionRound, verifierSummary }) {
    const workflow = instanceFor(run.workflowInstanceId);
    const workflowTemplate = workflow
      ? getTemplate({ templateId: workflow.templateId, version: workflow.templateVersion })
      : undefined;
    const target = resolveLoopDispatchTarget({ task, workflowDefinition: workflowTemplate?.definition, targetId: remediation.nodeId });
    if (!target) throw new Error("remediation_target_invalid");
    const row = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? AND node_id = ?")
      .get(run.workflowInstanceId, target.workflowNodeId ?? remediation.nodeId);
    const latestOutput = row ? deserializeNode(row).output?.answerText : "";
    return startOpenCodeTurn({
      task,
      runId: run.runId,
      instanceId: run.agentLoopInstanceId,
      nodeId: target.id,
      sessionId: workspaceSessionId(task.projectId, task.taskId, `remediate-${remediation.nodeId}-${correctionRound}`),
      purpose: "remediation",
      prompt: loopDispatchPrompt({ task, target, verifierSummary, remediation: remediation.instruction, latestOutput }),
      details: { correctionRound, remediationInstruction: remediation.instruction, verifierSummary, sourceNodeId: target.workflowNodeId, loopRole: target.kind },
    });
  }

  async function startRemediationVerify({ task, run, correctionRound, remediationTurns }) {
    const workflow = instanceFor(run.workflowInstanceId);
    const workflowTemplate = workflow
      ? getTemplate({ templateId: workflow.templateId, version: workflow.templateVersion })
      : undefined;
    const verify = workflowTemplate?.definition?.nodes?.find((node) => node.kind === "verify");
    if (!verify) throw new Error("workflow_verify_node_missing");
    const nodes = db
      .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
      .all(run.workflowInstanceId)
      .map(deserializeNode);
    return startOpenCodeTurn({
      task,
      runId: run.runId,
      instanceId: run.workflowInstanceId,
      nodeId: verify.id,
      sessionId: workspaceSessionId(task.projectId, task.taskId, `reverify-${correctionRound}`),
      purpose: "remediation_verify",
      prompt: remediationVerifyPrompt({ task, verify, nodes, remediationTurns }),
      details: { correctionRound, remediationTurnIds: remediationTurns.map((item) => item.turnId) },
    });
  }

  async function startOpenCodeTurn({ task, runId, instanceId, nodeId, sessionId, purpose, prompt, details, attempt = 1 }) {
    const turnId = `turn-${randomUUID()}`;
    const timestamp = now();
    db.prepare(
      `INSERT INTO orchestration_harness_turns
       (turn_id, run_id, instance_id, node_id, session_id, purpose, status, details_json, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    ).run(
      turnId,
      runId,
      instanceId,
      nodeId ?? null,
      sessionId,
      purpose,
      JSON.stringify({ ...(details ?? {}), attempt, artifactSnapshot: captureArtifactSnapshot(task.cwd) }),
      timestamp,
      timestamp,
    );
    try {
      let hookLaunch;
      try {
        hookLaunch = await openCodeHookService?.registerSession?.({
          sessionId,
          cwd: task.cwd,
          onEvent: handleOpenCodeHookEvent,
        });
      } catch (error) {
        recordHarnessEvent({
          runId,
          type: "session.hook.unavailable",
          summary: "OpenCode hook could not be attached; terminal input remains available.",
          data: { sessionId, reason: error instanceof Error ? error.message : String(error) },
        });
      }
      sessionAuthority.registerLaunchProfile({
        workspaceSessionId: sessionId,
        taskId: task.taskId,
        command: opencodePath,
        // This is a native OpenCode mini-TUI, matching Orca's terminal model.
        // Prompt delivery happens inside the owned TUI; semantic completion is
        // derived from authenticated hook messages plus session.idle.
        args: ["--mini", "--model", task.architecture.sessionPlan.model, "--prompt", prompt],
        cwd: task.cwd,
        provider: "opencode",
        model: task.architecture.sessionPlan.model,
        cols: 100,
        rows: 30,
        stdin: "pipe",
        requirePty: true,
        env: hookLaunch?.env,
      });
      await sessionAuthority.activateSession({
        workspaceSessionId: sessionId,
        operationId: `harness:${turnId}`,
        callerId: "orchestration-harness",
        reason: purpose,
      });
    } catch (error) {
      db.prepare("UPDATE orchestration_harness_turns SET status = 'failed', output_json = ?, updated_at = ? WHERE turn_id = ?").run(
        JSON.stringify({ error: error instanceof Error ? error.message : String(error), answerText: "" }),
        now(),
        turnId,
      );
      throw error;
    }
    return { turnId, sessionId };
  }

  async function retryFailedTurn({ task, turn, output }) {
    const details = JSON.parse(turn.details_json || "{}");
    const previousAttempt = Number(details.attempt ?? 1);
    if (previousAttempt >= MAX_SESSION_ATTEMPTS) return false;
    const run = runFor(turn.run_id);
    if (!run || run.status !== "running") return false;
    const attempt = previousAttempt + 1;
    const retryData = {
      previousTurnId: turn.turn_id,
      previousSessionId: turn.session_id,
      purpose: turn.purpose,
      nodeId: turn.node_id ?? undefined,
      attempt,
      errorPreview: output.errorText?.slice(0, 500),
    };
    recordHarnessEvent({
      runId: run.runId,
      type: "session.retrying",
      summary: `Retrying ${turn.purpose}${turn.node_id ? ` (${turn.node_id})` : ""}: attempt ${attempt}/${MAX_SESSION_ATTEMPTS}.`,
      data: retryData,
    });
    recordSemanticEvent({
      taskId: task.taskId,
      cwd: task.cwd,
      sessionId: turn.session_id,
      type: "session.retrying",
      summary: `OpenCode Session retry ${attempt}/${MAX_SESSION_ATTEMPTS} started after a provider failure.`,
      data: { runId: run.runId, ...retryData },
    });

    if (turn.purpose === "initial") {
      await startConductorTurn({
        task,
        runId: run.runId,
        loopInstanceId: run.agentLoopInstanceId,
        workflowInstanceId: run.workflowInstanceId,
        purpose: "initial",
        attempt,
        previousTurnId: turn.turn_id,
      });
      return true;
    }
    if (turn.purpose === "workflow_node" && turn.node_id) {
      const node = db
        .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? AND node_id = ?")
        .get(run.workflowInstanceId, turn.node_id);
      if (!node) return false;
      await startWorkflowNode({ task, run, node: deserializeNode(node), attempt, previousTurnId: turn.turn_id });
      return true;
    }
    if (turn.purpose === "workflow_return" || turn.purpose === "session_return") {
      const nodes = db
        .prepare("SELECT * FROM orchestration_harness_nodes WHERE instance_id = ? ORDER BY created_at ASC")
        .all(run.workflowInstanceId)
        .map(deserializeNode);
      const workflow = instanceFor(run.workflowInstanceId);
      await startConductorTurn({
        task,
        runId: run.runId,
        loopInstanceId: run.agentLoopInstanceId,
        workflowInstanceId: run.workflowInstanceId,
        purpose: turn.purpose,
        workflowStatus: workflow?.status ?? "failed",
        workflowSummary: workflowSummary(nodes),
        attempt,
        previousTurnId: turn.turn_id,
      });
      return true;
    }
    if (turn.purpose === "remediation" && turn.node_id) {
      await startRemediationTurn({
        task,
        run,
        remediation: {
          nodeId: turn.node_id,
          instruction: String(details.remediationInstruction ?? "Address the verifier finding and update the deliverable."),
        },
        correctionRound: Number(details.correctionRound ?? 1),
        verifierSummary: String(details.verifierSummary ?? "Re-run the stated verification requirements."),
      });
      return true;
    }
    if (turn.purpose === "remediation_verify") {
      const correctionRound = Number(details.correctionRound ?? 1);
      const remediationTurns = db
        .prepare("SELECT * FROM orchestration_harness_turns WHERE run_id = ? AND purpose = 'remediation' ORDER BY started_at ASC")
        .all(run.runId)
        .map(deserializeTurn)
        .filter((item) => Number(item.details?.correctionRound ?? 0) === correctionRound);
      await startRemediationVerify({ task, run, correctionRound, remediationTurns });
      return true;
    }
    return false;
  }

  function failRun({ task, run, reason }) {
    const timestamp = now();
    db.prepare("UPDATE orchestration_harness_runs SET status = 'blocked', updated_at = ? WHERE run_id = ?").run(timestamp, run.runId);
    db.prepare("UPDATE orchestration_harness_tasks SET status = 'blocked', updated_at = ? WHERE task_id = ?").run(timestamp, task.taskId);
    recordHarnessEvent({ runId: run.runId, type: "agent_loop.failed", summary: `Agent Loop blocked: ${reason}.`, data: { reason } });
    recordSemanticEvent({ taskId: task.taskId, cwd: task.cwd, type: "agent_loop.failed", summary: `Agent Loop blocked: ${reason}.`, data: { runId: run.runId, reason } });
  }

  function recordHarnessEvent({ runId, type, summary, data }) {
    const previous = db.prepare("SELECT MAX(sequence) AS sequence FROM orchestration_harness_events WHERE run_id = ?").get(runId);
    const sequence = Number(previous?.sequence ?? 0) + 1;
    db.prepare(
      `INSERT INTO orchestration_harness_events (run_id, sequence, type, summary, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(runId, sequence, type, summary, JSON.stringify(data ?? {}), now());
  }

  function recordSemanticEvent({ taskId, cwd, sessionId, type, summary, data }) {
    return sessionStore.recordTaskEvent({ taskId, cwd, sessionId, type, summary, data });
  }

  function taskFor(taskId) {
    const row = db
      .prepare(
        `SELECT task_id, project_id, cwd, title, goal, architecture_id, architecture_json, status, created_at, updated_at
         FROM orchestration_harness_tasks WHERE task_id = ?`,
      )
      .get(requiredString(taskId, "taskId"));
    return row ? deserializeTask(row) : undefined;
  }

  function taskForRun(runId) {
    const row = db
      .prepare(
        `SELECT t.task_id, t.project_id, t.cwd, t.title, t.goal, t.architecture_id, t.architecture_json, t.status, t.created_at, t.updated_at
         FROM orchestration_harness_tasks t JOIN orchestration_harness_runs r ON r.task_id = t.task_id
         WHERE r.run_id = ?`,
      )
      .get(runId);
    return row ? deserializeTask(row) : undefined;
  }

  function runFor(runId) {
    const row = db.prepare("SELECT * FROM orchestration_harness_runs WHERE run_id = ?").get(runId);
    return row ? deserializeRun(row) : undefined;
  }

  function latestRunForTask(taskId) {
    const row = db.prepare("SELECT * FROM orchestration_harness_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId);
    return row ? deserializeRun(row) : undefined;
  }

  function instanceFor(instanceId) {
    const row = db.prepare("SELECT * FROM orchestration_harness_instances WHERE instance_id = ?").get(instanceId);
    return row ? deserializeInstance(row) : undefined;
  }

  return {
    ensureSeedTemplates,
    listTemplates,
    getTemplate,
    saveTemplateVersion,
    listTemplateBlueprints,
    getTemplateBlueprint,
    saveTemplateBlueprint,
    createHarnessTask,
    generateTemplateDraft,
    createManualTemplateDraft,
    readTemplateDraft,
    saveGeneratedTemplateDraft,
    listHarnessTasks,
    readTask,
    startHarnessRun,
    readRun,
    readArtifact,
    markTaskAchieved,
    handlePtyEvent,
    handleOpenCodeHookEvent,
    respondToAttention,
    close,
  };
}

function seedAgentLoopTemplate() {
  return {
    id: AGENT_LOOP_TEMPLATE_ID,
    family: "agent_loop",
    version: TEMPLATE_VERSION,
    name: "OpenCode Agent Loop",
    definition: dynamicLoopDefinition({
      conductor: { provider: "opencode", role: "Harness Conductor" },
      nestedWorkflow: { templateId: WORKFLOW_TEMPLATE_ID, version: TEMPLATE_VERSION },
    }),
  };
}

function dynamicLoopDefinition({ conductor, nestedWorkflow }) {
  return {
    conductor,
    nestedWorkflow,
    returnPolicy: {
      wakeOn: ["workflow.completed", "workflow.failed", "session.completed", "session.failed", "session.attention"],
      everyMeaningfulSessionReturn: true,
    },
    decisionPolicy: {
      allowedActions: ["launch_workflow", "dispatch", "verify", "deliver", "block"],
      maxDispatchesPerDecision: 1,
      dynamicReplanning: true,
    },
    correctionPolicy: { maxRounds: MAX_CORRECTION_ROUNDS, reverifyAfterRemediation: false },
  };
}

function seedWorkflowTemplate() {
  return {
    id: WORKFLOW_TEMPLATE_ID,
    family: "workflow",
    version: TEMPLATE_VERSION,
    name: "OpenCode Research & Verify Workflow",
    definition: {
      nodes: [
        { id: "research", role: "Researcher", dependsOn: [], kind: "delegate" },
        { id: "verify", role: "Verifier", dependsOn: ["research"], kind: "verify" },
      ],
      wakeOn: ["workflow.completed", "workflow.failed"],
    },
  };
}

function seedTemplateBlueprint({ loop, workflow }) {
  return {
    id: BLUEPRINT_ID,
    version: TEMPLATE_VERSION,
    name: "OpenCode Research & Verify",
    description: "Conductor owns the task mainline. A bounded Workflow returns as one execution unit; each later corrective Session wakes Conductor for the next decision.",
    agentLoopTemplate: templateReference(loop),
    workflowTemplate: templateReference(workflow),
    source: "seed",
  };
}

function initialConductorPrompt(task, workflowDefinition) {
  const workflowInputs = Array.isArray(workflowDefinition?.nodes)
    ? workflowDefinition.nodes.map((node) => {
        const dependencies = Array.isArray(node.dependsOn) && node.dependsOn.length ? `depends on ${node.dependsOn.join(", ")}` : "entry node";
        return `- ${node.id} (${node.role}; ${dependencies}): ${node.instruction || node.role}`;
      }).join("\n")
    : "- Workflow inputs are unavailable; describe no additional Sessions.";
  return [
    "You are the OpenCode Conductor for a controlled Agent Workspace Agent Loop.",
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    "A bounded Workflow is available as one execution unit. You own the next task decision; Runtime owns PTYs and Session delivery.",
    "These are bounded Workflow nodes, not Agent Loop Session targets. Runtime alone advances them by graph dependency once you launch the Workflow:",
    workflowInputs,
    "Do not edit files or run tools.",
    "Return ONLY one JSON object, without a markdown fence:",
    '{"action":"launch_workflow|block","summaryMarkdown":"Markdown visible in the task timeline","targetNodeId":"","instruction":""}',
    "Choose launch_workflow when the bounded graph is a valid first research round. Use block only when the task cannot safely begin. The summary must state the Markdown evidence standard and final artifact standard you will apply after the Workflow returns.",
  ].join("\n");
}

function finalConductorPrompt(task, { workflowStatus, workflowSummary: summary, dispatchTargets = [], deliveryContract }) {
  const targetList = dispatchTargets.length
    ? dispatchTargets.map((target) => `- ${target.id} (${target.role}): ${target.description}`).join("\n")
    : "- No additional Loop Session is registered for this Task.";
  const deliveryRule = deliveryContract?.finalArtifact
    ? `The final ${deliveryContract.finalArtifact.format} deliverable must exist at \`${deliveryContract.finalArtifact.path}\`. Only \`${deliveryContract.publisher.id}\` may create or update it.`
    : "This Task has no requested final file; only verified Markdown evidence is required.";
  return [
    "You are the OpenCode Conductor receiving durable Runtime evidence.",
    `Task: ${task.title}`,
    `Workflow status: ${workflowStatus}`,
    "Evidence from the bounded Workflow or the most recent Session return:",
    summary,
    "You own the task mainline. Runtime will execute exactly one Session action and wake you again with its durable result; never assume a correction has happened until you receive that return.",
    deliveryRule,
    "These are the only valid Conductor-dispatched Session targets. Workflow node executions are not Loop Sessions and are not listed here:",
    targetList,
    "Do not edit files or run tools. Return ONLY one JSON object, without markdown fences:",
    '{"action":"dispatch|verify|deliver|block","summaryMarkdown":"Markdown visible to the user","targetNodeId":"one listed Loop Session target for dispatch, otherwise empty","instruction":"one exact next assignment for dispatch, otherwise empty"}',
    "Choose dispatch for one concrete next action and send it only to the role that owns that evidence or artifact. If a search or synthesis role has a listed Markdown path, it may write only that file; otherwise it must return evidence without file changes. Publisher alone may write the final HTML/file. Choose verify only after the relevant corrective Session returns. Choose deliver only when the latest verifier says PASS and Runtime evidence contains every required artifact. Choose block only for a genuine unrecoverable condition. Never return multiple assignments in one turn.",
  ].join("\n");
}

function loopDispatchPrompt({ task, target, verifierSummary, remediation, latestOutput }) {
  const isPublisher = target.kind === "publisher";
  return [
    `You are the ${target.role} Session dispatched by Conductor through an Agent Loop.`,
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `Conductor dispatch target: ${target.id}.`,
    `Verifier findings:\n${verifierSummary || "The verifier did not provide text; inspect the stated task requirements."}`,
    `Your required correction: ${remediation}`,
    latestOutput ? `Your prior answer:\n${latestOutput}` : "",
    isPublisher
      ? `You are the only role allowed to create the final deliverable. Read the verified Markdown evidence, then write exactly \`${target.outputPath}\` as ${target.outputFormat}. Do not alter research evidence or unrelated files. Return concise Markdown beginning with PUBLISH_RESULT: and list the exact changed file.`
      : target.outputPath
        ? `You are an evidence role. Write or update only \`${target.outputPath}\` as Markdown evidence. Never create HTML, a webpage, or the final deliverable. Do not touch unrelated files and do not delegate. Return concise Markdown beginning with REMEDIATION_RESULT: and list the exact changed file.`
        : "This is an evidence-only Task. Do not modify files, create HTML, or create a final deliverable. Do not delegate. Return concise Markdown beginning with REMEDIATION_RESULT: and include the corrected bounded evidence.",
  ].filter(Boolean).join("\n");
}

function remediationVerifyPrompt({ task, verify, nodes, remediationTurns }) {
  const originalEvidence = workflowSummary(nodes);
  const remediationEvidence = remediationTurns
    .map((turn) => `${turn.nodeId}: ${String(turn.output?.answerText ?? "no remediation output").slice(0, 3000)}`)
    .join("\n\n");
  return [
    `You are the ${verify.role} Session performing a fresh verification after automatic remediation.`,
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    "Original Workflow evidence:",
    originalEvidence,
    "Remediation evidence:",
    remediationEvidence,
    "Inspect the current workspace state. Do not delegate. Reply beginning with VERIFY_RESULT: PASS only if the deliverable now satisfies the task; otherwise begin with VERIFY_RESULT: NEEDS_REMEDIATION and identify the responsible existing node id plus an exact corrective action.",
  ].join("\n");
}

function workflowNodePrompt(task, node, nodes) {
  const dependencyOutput = nodes
    .filter((item) => node.dependsOn.includes(item.nodeId))
    .map((item) => `${item.nodeId}: ${String(item.output?.answerText ?? "no output").slice(0, 2000)}`)
    .join("\n\n");
  const isVerification = node.kind === "verify" || /verify|review|qa/i.test(`${node.id} ${node.role}`);
  const instruction = String(node.instruction || node.role || node.id).trim();
  const artifact = workflowEvidenceContract(task, node.id);
  return [
    `You are the ${node.role} node in a bounded Agent Workspace Workflow.`,
    `Task: ${task.title}`,
    `Goal: ${task.goal}`,
    `Node: ${node.id}`,
    `Node responsibility: ${instruction}`,
    "You are one Runtime-managed OpenCode Session. Do not dispatch, spawn, or wait for other agents; parallel work is represented by separate Workflow nodes.",
    artifact
      ? `Write your bounded result to \`${artifact.path}\` as Markdown. This is your only writable evidence path. Never create HTML, a webpage, or the final deliverable; those belong to a Conductor-dispatched Publisher Session.`
      : "Do not modify files or run tools. Return concise evidence only.",
    isVerification
      ? `Reply beginning with ${node.id.toUpperCase()}_RESULT: and include PASS or NEEDS_REVIEW.`
      : `Reply beginning with ${node.id.toUpperCase()}_RESULT: and state the bounded result and key risk.`,
    dependencyOutput ? "Declared dependency evidence:\n" + dependencyOutput : "This is an entry node with no dependency evidence.",
  ].join("\n");
}

function workflowSummary(nodes) {
  return nodes
    .map((node) => `${node.nodeId} (${node.status}): ${String(node.output?.answerText ?? "no output").slice(0, 2000)}`)
    .join("\n\n");
}

function taskRequiresArtifact(goal) {
  const source = String(goal ?? "");
  // A constraint such as "do not create files" is not a delivery request.
  // Treat it as evidence-only unless the same goal explicitly names a final
  // deliverable format/path.
  const explicitFinal = /\bhtml\b|\.html?\b|最终.{0,24}(?:文件|页面|交付)|生成.{0,24}(?:html|文件|页面)|做成.{0,24}(?:html|文件|页面)/i.test(source);
  if (!explicitFinal && /\b(?:do not|don't|no)\s+(?:create|write|modify|save|use)\s+files?\b|不要.{0,16}(?:创建|生成|写).{0,16}文件|无需.{0,16}文件|不需要.{0,16}文件/i.test(source)) {
    return false;
  }
  return /\b(html|file|write|save|implement|artifact)\b|文件|落地|实现|写入|生成.{0,12}(文件|页面|html)/i.test(source);
}

function createTaskDeliveryContract({ taskId, title, goal, workflowNodes }) {
  if (!taskRequiresArtifact(goal)) return { evidence: [] };
  const evidence = (workflowNodes ?? []).map((node) => ({
    nodeId: node.id,
    path: `evidence/${safeSegment(taskId)}/${safeSegment(node.id)}.md`,
    format: "markdown",
    kind: node.kind === "verify" ? "verification" : "evidence",
  }));
  const finalArtifact = requestedFinalArtifact({ taskId, title, goal });
  return {
    evidence,
    finalArtifact,
    publisher: {
      id: "publisher",
      role: finalArtifact.format === "html" ? "HTML Publisher" : "Deliverable Publisher",
    },
  };
}

function requestedFinalArtifact({ taskId, title, goal }) {
  const source = String(goal ?? "");
  const explicit = source.match(/(?:^|[\s`'\"])([a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:html?|md|mdx|txt|json))(?:$|[\s`'\"，。；、])/i)?.[1];
  const format = /\.html?$/i.test(explicit ?? "") || /\bhtml\b|网页|页面/i.test(source)
    ? "html"
    : /\.json$/i.test(explicit ?? "")
      ? "json"
      : /\.txt$/i.test(explicit ?? "")
        ? "text"
        : "markdown";
  const suffix = format === "html" ? "html" : format === "json" ? "json" : format === "text" ? "txt" : "md";
  const filename = explicit ? path.basename(explicit) : `${safeSegment(title)}.${suffix}`;
  return { path: `deliverables/${safeSegment(taskId)}/${filename}`, format };
}

function taskDeliveryContract(task) {
  const stored = task?.architecture?.sessionPlan?.deliveryContract;
  if (stored && typeof stored === "object") return stored;
  return createTaskDeliveryContract({
    taskId: task.taskId,
    title: task.title,
    goal: task.goal,
    workflowNodes: [],
  });
}

function workflowEvidenceContract(task, nodeId) {
  return (taskDeliveryContract(task).evidence ?? []).find((item) => item.nodeId === nodeId);
}

function loopDispatchTargetsForTask(task, workflowDefinition) {
  const workflowTargets = (workflowDefinition?.nodes ?? []).filter((node) => node.kind !== "verify").map((node) => {
    const artifact = workflowEvidenceContract(task, node.id);
    return {
      id: node.id,
      role: node.role,
      kind: "evidence_repair",
      workflowNodeId: node.id,
      outputPath: artifact?.path,
      outputFormat: "markdown",
      description: artifact?.path ? `repair only its Markdown evidence at ${artifact.path}` : "return bounded evidence only; no file changes",
    };
  });
  const contract = taskDeliveryContract(task);
  if (!contract?.publisher || !contract?.finalArtifact) return workflowTargets;
  return [
    ...workflowTargets,
    {
      id: contract.publisher.id,
      role: contract.publisher.role,
      kind: "publisher",
      outputPath: contract.finalArtifact.path,
      outputFormat: contract.finalArtifact.format,
      description: `create the final ${contract.finalArtifact.format} deliverable at ${contract.finalArtifact.path}`,
    },
  ];
}

function resolveLoopDispatchTarget({ task, workflowDefinition, targetId }) {
  return loopDispatchTargetsForTask(task, workflowDefinition).find((item) => item.id === targetId);
}

function correctionRoundBudget(definition) {
  const value = Number(definition?.correctionPolicy?.maxRounds ?? MAX_CORRECTION_ROUNDS);
  return Number.isSafeInteger(value) && value >= 0 && value <= 8 ? value : MAX_CORRECTION_ROUNDS;
}

function isVerificationPass(value) {
  return /(?:VERIFY_RESULT:\s*)?PASS\b/i.test(String(value ?? "")) && !/NEEDS_(?:REVIEW|REMEDIATION)|FAIL|BLOCK/i.test(String(value ?? ""));
}

function normalizeConductorDecision({ answerText, phase = "workflow_return", workflowStatus, nodeIds, verifierPassed, requiresArtifact, artifacts, deliveryContract }) {
  const parsed = extractConductorDecision(answerText);
  const finalArtifact = deliveryContract?.finalArtifact;
  const finalArtifactPresent = finalArtifact
    ? artifacts.some((artifact) => artifact.path === finalArtifact.path)
    : artifacts.length > 0;
  const hasRequiredArtifacts = !requiresArtifact || finalArtifactPresent;
  let action = parsed?.action;
  let remediations = parsed?.remediations ?? [];

  if (phase === "initial" && !action) action = "launch_workflow";
  if (!action) {
    action = workflowStatus === "succeeded" && verifierPassed && hasRequiredArtifacts ? "deliver" : "block";
  }
  if (phase !== "initial" && workflowStatus !== "succeeded" && action === "deliver") action = "block";
  if (action === "deliver" && (!verifierPassed || !hasRequiredArtifacts)) action = "block";

  // A final file is a separate ownership boundary. Once the research graph
  // has passed verification, route the deliverable to Publisher even if the
  // model prematurely says "deliver" or omits a JSON decision altogether.
  if (
    phase !== "initial" &&
    workflowStatus === "succeeded" &&
    verifierPassed &&
    finalArtifact &&
    !finalArtifactPresent &&
    nodeIds.includes(deliveryContract?.publisher?.id ?? "")
  ) {
    action = "dispatch";
    remediations = [{
      nodeId: deliveryContract.publisher.id,
      instruction: `Create the final ${finalArtifact.format} deliverable at ${finalArtifact.path} from the verified Markdown evidence.`,
    }];
  }

  if (action === "dispatch") {
    remediations = remediations
      .filter((item) => nodeIds.includes(item.nodeId) && item.instruction)
      .slice(0, 1);
    if (!remediations.length) action = "block";
  } else {
    remediations = [];
  }
  if (action === "verify" && !workflowStatus) action = "block";
  if (phase === "initial" && !["launch_workflow", "block"].includes(action)) action = "block";

  const fallbackSummary =
    action === "launch_workflow"
      ? "## 执行计划\nConductor 已确认第一轮受限 Workflow；它完成后会根据证据决定下一步。"
      : action === "dispatch"
        ? `## 下一步\nConductor 将一个明确修复派给 \`${remediations[0]?.nodeId}\`；该 Session 返回后才会作出下一次决定。`
        : action === "verify"
          ? "## 下一步\nConductor 已要求基于当前证据进行一次独立复验；复验结果会再次返回给 Conductor。"
          : action === "deliver"
            ? "## 交付摘要\n验证通过，Runtime 已索引本次运行实际产生的交付产物。现在由你直接查看文件。"
            : "## 无法继续\n当前证据不足以安全交付，Runtime 已保留失败证据。";
  return { action, remediations, summaryMarkdown: String(parsed?.summaryMarkdown || fallbackSummary).trim() };
}

function presentConductorOutput({ output, decision }) {
  return {
    ...output,
    answerText: decision.summaryMarkdown,
    decision: decision.action,
    action: decision.action,
    remediations: decision.remediations,
  };
}

function extractConductorDecision(value) {
  const source = String(value ?? "").trim();
  const start = source.indexOf("{");
  if (start < 0) return undefined;
  const end = matchingJsonObjectEnd(source, start);
  if (end < 0) return undefined;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (!parsed || typeof parsed !== "object") return undefined;
    const legacyDecision = String(parsed.decision ?? "").trim();
    const action = String(parsed.action ?? (legacyDecision === "remediate" ? "dispatch" : legacyDecision)).trim();
    if (!["launch_workflow", "dispatch", "verify", "deliver", "block"].includes(action)) return undefined;
    const legacyRemediations = Array.isArray(parsed.remediations) ? parsed.remediations : [];
    const targetNodeId = String(parsed.targetNodeId ?? "").trim();
    const instruction = String(parsed.instruction ?? "").trim();
    const remediations = legacyRemediations.length
      ? legacyRemediations.map((item) => ({ nodeId: String(item?.nodeId ?? ""), instruction: String(item?.instruction ?? "").trim() }))
      : targetNodeId || instruction
        ? [{ nodeId: targetNodeId, instruction }]
        : [];
    return {
      action,
      summaryMarkdown: typeof parsed.summaryMarkdown === "string" ? parsed.summaryMarkdown : undefined,
      remediations,
    };
  } catch {
    return undefined;
  }
}

function extractOpenCodeOutput(transcript) {
  const answerParts = [];
  const errorParts = [];
  const terminalParts = [];
  let sessionId;
  let completedAt;
  for (const raw of String(transcript ?? "").split(/\r?\n/)) {
    const line = stripAnsi(raw).trim();
    if (!line.startsWith("{")) {
      if (line) terminalParts.push(line);
      continue;
    }
    try {
      const event = JSON.parse(line);
      if (event.sessionID) sessionId = event.sessionID;
      if (event.type === "text" && typeof event.part?.text === "string") answerParts.push(event.part.text);
      if (event.type === "error" || event.type === "step_error") {
        const diagnostic = event.error?.message ?? event.part?.message ?? event.message;
        if (typeof diagnostic === "string") errorParts.push(diagnostic);
      }
      if (event.type === "step_finish") completedAt = Number(event.timestamp) || Date.now();
    } catch {
      // `opencode run` defaults to its human terminal format. Keep those
      // lines as a semantic fallback while still preferring structured events
      // when a caller explicitly requests JSON.
      if (line) terminalParts.push(line);
    }
  }
  const answerText = answerParts.join("\n").trim() || terminalParts.join("\n").trim();
  return {
    answerText,
    errorText: errorParts.join("\n").trim(),
    providerSessionId: sessionId,
    completedAt,
    source: answerParts.length ? "opencode-run-json" : "opencode-run-terminal",
  };
}

function captureArtifactSnapshot(cwd) {
  const paths = gitChangedPaths(cwd);
  return Object.fromEntries(paths.map((relativePath) => [relativePath, fileFingerprint(cwd, relativePath)]).filter(([, value]) => value));
}

function detectArtifacts({ cwd, before }) {
  const baseline = before && typeof before === "object" && !Array.isArray(before) ? before : {};
  const paths = new Set([...Object.keys(baseline), ...gitChangedPaths(cwd)]);
  const artifacts = [];
  for (const relativePath of paths) {
    const previous = baseline[relativePath];
    const next = fileFingerprint(cwd, relativePath);
    if (!next || (previous && previous.digest === next.digest)) continue;
    artifacts.push({
      path: relativePath,
      change: previous ? "modified" : "added",
      size: next.size,
      digest: next.digest,
      previewable: isPreviewableArtifact(relativePath, next.size),
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

function listRunArtifacts({ task, turns }) {
  const byPath = new Map();
  for (const turn of turns ?? []) {
    for (const artifact of turn.output?.artifacts ?? []) {
      if (!artifact?.path) continue;
      byPath.set(artifact.path, {
        ...artifact,
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        nodeId: turn.nodeId,
        purpose: turn.purpose,
      });
    }
  }
  return [...byPath.values()].map((artifact) => ({ ...artifact, absolutePath: path.join(task.cwd, artifact.path) }));
}

function readArtifactFile({ cwd, artifact }) {
  const relativePath = requiredArtifactPath(artifact.path);
  const absolutePath = path.resolve(cwd, relativePath);
  const root = path.resolve(cwd);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error("harness_artifact_path_outside_task");
  if (!fs.existsSync(absolutePath)) return { ...artifact, exists: false, content: "", contentType: "missing" };
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) return { ...artifact, exists: true, content: "", contentType: "unsupported" };
  if (!isPreviewableArtifact(relativePath, stat.size)) return { ...artifact, exists: true, content: "", contentType: "unsupported" };
  const content = fs.readFileSync(absolutePath, "utf8");
  return {
    ...artifact,
    exists: true,
    content,
    contentType: /\.mdx?$/i.test(relativePath) ? "markdown" : /\.html?$/i.test(relativePath) ? "html" : "text",
  };
}

function requiredArtifactPath(value) {
  const relativePath = String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) throw new Error("harness_artifact_path_invalid");
  return relativePath;
}

function gitChangedPaths(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 2 * 1024 * 1024,
    });
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).replace(/^"|"$/g, "").trim())
      .filter((relativePath) => relativePath && !relativePath.includes(" -> "))
      .filter((relativePath) => !relativePath.startsWith(".agent-workspace/"));
  } catch {
    return [];
  }
}

function fileFingerprint(cwd, relativePath) {
  try {
    const absolutePath = path.resolve(cwd, requiredArtifactPath(relativePath));
    const root = path.resolve(cwd);
    if (!absolutePath.startsWith(`${root}${path.sep}`)) return undefined;
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return undefined;
    const digest = crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
    return { digest, size: stat.size };
  } catch {
    return undefined;
  }
}

function isPreviewableArtifact(relativePath, size) {
  return Number(size) <= 512 * 1024 && /\.(?:md|mdx|txt|json|ya?ml|html?|css|js|cjs|mjs|ts|tsx|jsx|py|sh)$/i.test(relativePath);
}

function templateDraftPrompt({ title, goal, attempt }) {
  return [
    "You are an architecture planner for Agent Workspace. This is template planning only: do not run tools, edit files, or claim task completion.",
    `Task title: ${title}`,
    `Task goal: ${goal}`,
    `Generation attempt: ${attempt}. Return ONLY one valid JSON object, without markdown fences or explanatory text.`,
    "The object must have exactly these top-level fields: agentLoop, workflow, rationale, assumptions.",
    "agentLoop: { name: string, conductorRole: string }.",
    "workflow: { name: string, nodes: [{ id: lowercase-kebab-case, role: short 2-5 word label, instruction: one bounded responsibility, kind: delegate|verify, dependsOn: string[] }] }.",
    "Use 2 to 6 nodes. Node ids must be unique, dependencies must refer only to prior nodes, and the final node must have kind verify.",
    "Each Workflow node is exactly one Runtime-managed OpenCode Session. Never make a node dispatch, spawn, or manage other agents.",
    "If the goal asks for several independent agents, express them as separate, dependency-free delegate nodes (for example search-a, search-b, search-c), then make a synthesis node depend on all of them. Runtime can run up to two ready nodes in parallel.",
    "The Agent Loop is not a Workflow graph: Conductor receives the bounded Workflow return and every later corrective Session return, then selects one next assignment, verification, delivery, or block action. Do not put Loop decisions into Workflow nodes.",
  ].join("\n");
}

function extractJsonObject(value) {
  const source = String(value ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (let start = source.indexOf("{"); start >= 0; start = source.indexOf("{", start + 1)) {
    const end = matchingJsonObjectEnd(source, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      if (parsed?.agentLoop && parsed?.workflow) return parsed;
    } catch {
      // Continue to the next balanced object rather than trusting surrounding prose.
    }
  }
  throw new Error("template_draft_invalid_json");
}

function matchingJsonObjectEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaping) escaping = false;
      else if (character === "\\") escaping = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function resolveNodeIdentities(nodes, registry = WORKFLOW_NODE_REGISTRY) {
  for (const node of nodes) {
    if (!registry.kinds.includes(node.kind)) {
      throw new Error(`workflow_phantom_node_kind: "${node.kind}" is not a registered node kind`);
    }
  }
}

function normalizeGeneratedArchitecture(input, { title = "Untitled Template", description } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("template_draft_shape_invalid");
  const agentLoopInput = input.agentLoop;
  const workflowInput = input.workflow;
  if (!agentLoopInput || typeof agentLoopInput !== "object" || !workflowInput || typeof workflowInput !== "object") {
    throw new Error("template_draft_shape_invalid");
  }
  const loopName = requiredString(agentLoopInput.name, "agentLoop.name").slice(0, 120);
  const workflowName = requiredString(workflowInput.name, "workflow.name").slice(0, 120);
  const nodesInput = Array.isArray(workflowInput.nodes) ? workflowInput.nodes : [];
  if (nodesInput.length < 2 || nodesInput.length > MAX_WORKFLOW_NODES) throw new Error("workflow_node_count_invalid");
  const seen = new Set();
  const nodes = nodesInput.map((item, index) => {
    const id = safeSegment(requiredString(item?.id, `workflow.nodes[${index}].id`));
    if (seen.has(id)) throw new Error("workflow_node_id_duplicate");
    seen.add(id);
    const dependsOn = Array.isArray(item?.dependsOn) ? item.dependsOn.map(safeSegment) : [];
    if (dependsOn.some((dependency) => !seen.has(dependency))) throw new Error("workflow_dependency_must_reference_prior_node");
    if (item?.kind !== "delegate" && item?.kind !== "verify") {
      throw new Error(`workflow_phantom_node_kind: "${item?.kind}" is not a registered node kind`);
    }
    const kind = item.kind;
    const role = requiredString(item?.role || id, `workflow.nodes[${index}].role`).slice(0, 100);
    const instruction = String(item?.instruction || item?.description || role).trim().slice(0, 800);
    if (/(dispatch|delegate|spawn|分派|调度).{0,50}(agent|agents|智能体)/i.test(`${role} ${instruction}`)) {
      throw new Error("workflow_node_must_be_single_session_work");
    }
    return {
      id,
      role,
      instruction,
      kind,
      dependsOn,
    };
  });
  resolveNodeIdentities(nodes);
  if (nodes.at(-1)?.kind !== "verify") throw new Error("workflow_final_node_must_verify");
  const workflowId = `generated-${safeSegment(workflowName)}-workflow`;
  const agentLoopId = `generated-${safeSegment(loopName)}-agent-loop`;
  const blueprintName = String(input.template?.name || title || loopName).trim().slice(0, 120) || loopName;
  return {
    blueprint: {
      id: `blueprint-${safeSegment(blueprintName)}`,
      name: blueprintName,
      description: String(input.template?.description || description || input.rationale || "").trim().slice(0, 1_500),
    },
    agentLoop: {
      id: agentLoopId,
      name: loopName,
      definition: {
        conductor: {
          provider: "opencode",
          role: requiredString(agentLoopInput.conductorRole || "Conductor", "agentLoop.conductorRole").slice(0, 100),
        },
      },
    },
    workflow: {
      id: workflowId,
      name: workflowName,
      definition: { nodes, wakeOn: ["workflow.completed", "workflow.failed"] },
    },
    rationale: String(input.rationale ?? "").trim().slice(0, 1_500),
    assumptions: Array.isArray(input.assumptions)
      ? input.assumptions.map((value) => String(value).trim()).filter(Boolean).slice(0, 8)
      : [],
  };
}

function assertExecutableWorkflowDefinition(definition) {
  const nodes = Array.isArray(definition?.nodes) ? definition.nodes : [];
  if (!nodes.length) throw new Error("workflow_template_nodes_missing");
  resolveNodeIdentities(nodes);
  const nodeIds = new Set(nodes.map((node) => node?.id).filter(Boolean));
  for (const node of nodes) {
    const deps = Array.isArray(node?.dependsOn) ? node.dependsOn : [];
    for (const dep of deps) {
      if (!nodeIds.has(dep)) {
        throw new Error(`Workflow node "${node?.id ?? "unknown"}" references unknown dependency "${dep}". Every dependsOn target must match a defined node id.`);
      }
    }
    const label = `${node?.role ?? ""} ${node?.instruction ?? node?.description ?? ""}`;
    if (/(dispatch|delegate|spawn|分派|调度).{0,50}(agent|agents|智能体)/i.test(label)) {
      throw new Error(`Workflow node "${node?.id ?? "unknown"}" tries to dispatch other agents. Create a new Template version with one independent Workflow node per agent.`);
    }
  }
}

function normalizeTemplate(input) {
  const family = String(input?.family ?? "");
  if (family !== "agent_loop" && family !== "workflow") throw new Error("template_family_invalid");
  const id = safeSegment(requiredString(input?.id, "template id"));
  const version = Number(input?.version ?? 1);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("template_version_invalid");
  const name = requiredString(input?.name, "template name");
  const definition = input?.definition && typeof input.definition === "object" && !Array.isArray(input.definition) ? input.definition : undefined;
  if (!definition) throw new Error("template_definition_invalid");
  return { id, family, version, name, definition };
}

function deserializeTemplate(row) {
  return { id: row.id, family: row.family, version: Number(row.version), name: row.name, definition: JSON.parse(row.definition_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

function deserializeTask(row) {
  return {
    taskId: row.task_id,
    projectId: row.project_id,
    cwd: row.cwd,
    title: row.title,
    goal: row.goal,
    architectureId: row.architecture_id,
    architecture: JSON.parse(row.architecture_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeRun(row) {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    architectureId: row.architecture_id,
    status: row.status,
    agentLoopInstanceId: row.agent_loop_instance_id,
    workflowInstanceId: row.workflow_instance_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeInstance(row) {
  return {
    instanceId: row.instance_id,
    runId: row.run_id,
    kind: row.kind,
    parentInstanceId: row.parent_instance_id,
    templateId: row.template_id,
    templateVersion: Number(row.template_version),
    status: row.status,
    phase: row.phase,
    details: JSON.parse(row.details_json || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeNode(row) {
  return {
    instanceId: row.instance_id,
    nodeId: row.node_id,
    role: row.role,
    dependencies: JSON.parse(row.dependencies_json || "[]"),
    status: row.status,
    output: row.output_json ? JSON.parse(row.output_json) : undefined,
    details: JSON.parse(row.details_json || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deserializeTurn(row) {
  return {
    turnId: row.turn_id,
    runId: row.run_id,
    instanceId: row.instance_id,
    nodeId: row.node_id,
    sessionId: row.session_id,
    purpose: row.purpose,
    status: row.status,
    output: row.output_json ? JSON.parse(row.output_json) : undefined,
    details: JSON.parse(row.details_json || "{}"),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function deserializeHarnessEvent(row) {
  return { runId: row.run_id, sequence: Number(row.sequence), type: row.type, summary: row.summary, data: JSON.parse(row.data_json || "{}"), createdAt: row.created_at };
}

function deserializeAttention(row) {
  return {
    attentionId: row.attention_id,
    runId: row.run_id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    payload: JSON.parse(row.payload_json || "{}"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function sanitizeHookPayload(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 24).map((item) => sanitizeHookPayload(item, depth + 1));
  if (!value || typeof value !== "object") return String(value ?? "").slice(0, 4_000);
  return Object.fromEntries(Object.entries(value).slice(0, 48).map(([key, item]) => [key.slice(0, 160), sanitizeHookPayload(item, depth + 1)]));
}

function deserializeTemplateDraft(row) {
  return {
    draftId: row.draft_id,
    cwd: row.cwd,
    title: row.title,
    goal: row.goal,
    model: row.model,
    status: row.status,
    candidate: JSON.parse(row.candidate_json),
    providerOutput: JSON.parse(row.provider_output_json || "{}"),
    savedTemplates: row.saved_templates_json ? JSON.parse(row.saved_templates_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTemplateBlueprint(input) {
  const id = safeSegment(requiredString(input?.id, "blueprint id"));
  const version = Number(input?.version ?? 1);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("template_blueprint_version_invalid");
  const name = requiredString(input?.name, "blueprint name").slice(0, 120);
  const description = String(input?.description ?? "").trim().slice(0, 1_500);
  const agentLoopTemplate = input?.agentLoopTemplate;
  const workflowTemplate = input?.workflowTemplate;
  if (!agentLoopTemplate?.id || !Number.isSafeInteger(Number(agentLoopTemplate.version))) throw new Error("template_blueprint_agent_loop_invalid");
  if (!workflowTemplate?.id || !Number.isSafeInteger(Number(workflowTemplate.version))) throw new Error("template_blueprint_workflow_invalid");
  const source = ["seed", "generated", "manual"].includes(String(input?.source)) ? String(input.source) : "manual";
  return {
    id,
    version,
    name,
    description,
    agentLoopTemplate: { id: safeSegment(agentLoopTemplate.id), version: Number(agentLoopTemplate.version) },
    workflowTemplate: { id: safeSegment(workflowTemplate.id), version: Number(workflowTemplate.version) },
    source,
  };
}

function deserializeTemplateBlueprint(row) {
  return {
    id: row.blueprint_id,
    version: Number(row.version),
    name: row.name,
    description: row.description,
    agentLoopTemplate: {
      id: row.agent_loop_template_id,
      version: Number(row.agent_loop_template_version),
      family: "agent_loop",
    },
    workflowTemplate: {
      id: row.workflow_template_id,
      version: Number(row.workflow_template_version),
      family: "workflow",
    },
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function templateReference(template) {
  return { id: template.id, version: template.version, family: template.family, name: template.name };
}

function templateBlueprintReference(blueprint) {
  return {
    id: blueprint.id,
    version: blueprint.version,
    name: blueprint.name,
    description: blueprint.description,
    source: blueprint.source,
    agentLoopTemplate: blueprint.agentLoopTemplate,
    workflowTemplate: blueprint.workflowTemplate,
  };
}

function workspaceSessionId(projectId, taskId, agentId) {
  return `opencode:${safeSegment(projectId)}:${safeSegment(taskId)}:${safeSegment(agentId)}`;
}

function requiredString(value, field) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`Orchestration Harness requires ${field}.`);
  return result;
}

function safeSegment(value) {
  const result = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result) throw new Error("Orchestration Harness identity segment is required.");
  return result;
}

function stripAnsi(value) {
  return String(value).replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, "");
}

function ensureDatabaseDirectory(databasePath) {
  if (!databasePath || databasePath === ":memory:") return;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

function assertWritableProjectDirectory(input) {
  const cwd = path.resolve(input);
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(`Harness Task requires a readable and writable project directory: ${cwd}`);
  }
}

function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_template_versions (
      id TEXT NOT NULL,
      family TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (id, version)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_tasks (
      task_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      architecture_id TEXT NOT NULL,
      architecture_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      architecture_id TEXT NOT NULL,
      status TEXT NOT NULL,
      agent_loop_instance_id TEXT NOT NULL,
      workflow_instance_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_instances (
      instance_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_instance_id TEXT,
      template_id TEXT NOT NULL,
      template_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_nodes (
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      role TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (instance_id, node_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_turns (
      turn_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      node_id TEXT,
      session_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      details_json TEXT NOT NULL,
      output_json TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_events (
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (run_id, sequence)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_harness_attentions (
      attention_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_template_drafts (
      draft_id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      provider_output_json TEXT NOT NULL,
      saved_templates_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS orchestration_template_blueprints (
      blueprint_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      agent_loop_template_id TEXT NOT NULL,
      agent_loop_template_version INTEGER NOT NULL,
      workflow_template_id TEXT NOT NULL,
      workflow_template_version INTEGER NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (blueprint_id, version)
    ) STRICT;

    /* v1 incorrectly promoted a failed Workflow return to ready_for_review. */
    UPDATE orchestration_harness_runs
    SET status = 'blocked'
    WHERE status = 'ready_for_review'
      AND EXISTS (
        SELECT 1
        FROM orchestration_harness_instances workflow
        WHERE workflow.instance_id = orchestration_harness_runs.workflow_instance_id
          AND workflow.kind = 'workflow'
          AND workflow.status = 'failed'
      );

    UPDATE orchestration_harness_tasks
    SET status = 'blocked'
    WHERE EXISTS (
      SELECT 1
      FROM orchestration_harness_runs run
      INNER JOIN orchestration_harness_instances workflow ON workflow.instance_id = run.workflow_instance_id
      WHERE run.task_id = orchestration_harness_tasks.task_id
        AND run.status = 'blocked'
        AND workflow.kind = 'workflow'
        AND workflow.status = 'failed'
    );

    UPDATE orchestration_harness_instances
    SET status = 'failed', updated_at = CURRENT_TIMESTAMP
    WHERE kind = 'agent_loop'
      AND EXISTS (
        SELECT 1
        FROM orchestration_harness_runs run
        INNER JOIN orchestration_harness_instances workflow ON workflow.instance_id = run.workflow_instance_id
        WHERE run.agent_loop_instance_id = orchestration_harness_instances.instance_id
          AND run.status = 'blocked'
          AND workflow.kind = 'workflow'
          AND workflow.status = 'failed'
      );
  `);
}

module.exports = {
  AGENT_LOOP_TEMPLATE_ID,
  BLUEPRINT_ID,
  DEFAULT_MODEL,
  TEMPLATE_VERSION,
  WORKFLOW_NODE_REGISTRY,
  WORKFLOW_TEMPLATE_ID,
  createOrchestrationHarness,
  extractOpenCodeOutput,
  resolveNodeIdentities,
};
