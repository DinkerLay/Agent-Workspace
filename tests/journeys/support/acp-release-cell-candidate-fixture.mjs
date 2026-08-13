import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export async function runAcpReleaseCellCandidateFixture(mutation = "", forgeAuthority = false) {
  const args = Object.fromEntries(Array.from(
    { length: process.argv.slice(2).length / 2 },
    (_, index) => [process.argv[2 + index * 2].slice(2), process.argv[3 + index * 2]],
  ));
  if (mutation === "safe-runner-failure") {
    process.stderr.write("raw secret /Users/operator/private-token\n");
    process.stderr.write(JSON.stringify({
      outcome: "FAIL",
      code: "codex_scoped_tool_probe_incomplete:calls_0:elicitations_0",
    }) + "\n");
    process.exitCode = 1;
    return;
  }
  const matrix = JSON.parse(await readFile(args.matrix, "utf8"));
  const cell = matrix.cells.find((candidate) =>
    candidate.bundleCellId === args.cell && candidate.scenarioId === args.scenario);
  if (!cell) throw new Error("fixture_release_cell_missing");
  const suffix = cell.bundleCellId.slice("cell_".length).replaceAll("_", "-");
  const acpTaskCell = cell.bundleCellId === "cell_opencode-acp-task"
    || cell.bundleCellId === "cell_codex-acp-task";
  const acpMetaCell = cell.bundleCellId === "cell_acp-meta";
  const observedCore = {
    schemaVersion: 1,
    runtimeInstanceId: cell.lineage.runtimeInstanceId,
    templateDraftIds: ["template_draft_" + suffix],
    taskSetupDraftIds: ["task_setup_draft_" + suffix],
    taskIds: acpMetaCell ? [] : ["task_" + suffix],
    runIds: acpMetaCell ? [] : ["run_" + suffix],
    metaSessionIds: acpTaskCell ? [] : ["meta_session_" + suffix],
    metaTurnIds: acpTaskCell ? [] : ["meta_turn_" + suffix],
    cardSessionSlotIds: acpMetaCell ? [] : ["card_session_slot_" + suffix],
    logicalSessionIds: acpMetaCell ? [] : ["logical_session_" + suffix],
    bindingIds: acpMetaCell ? [] : ["binding_" + suffix],
    messageIds: [mutation === "cross-cell-reuse" ? "message_cross-cell-reused" : "message_" + suffix],
    messageForwardIds: [],
    humanInterventionIds: [],
    inputSubmissionIds: acpMetaCell ? [] : ["input_" + suffix],
    sessionTurnIds: acpMetaCell ? [] : ["session_turn_" + suffix],
    sessionControlAuditIds: [],
  };
  if (mutation === "missing") delete observedCore.metaTurnIds;
  if (mutation === "extra") observedCore.fallbackIds = ["fallback_" + suffix];
  if (mutation === "fallback") observedCore.taskIds = ["task_fallback-" + suffix];
  const observedLineage = {
    ...observedCore,
    canonicalDigest: "sha256:" + createHash("sha256")
      .update(canonicalJson(observedCore)).digest("hex"),
  };
  const uiEvidence = new Map(cell.streamRequirements.flatMap((requirement) => {
    const ui = requirement.issuer === "browser_ui_driver" || requirement.issuer === "electron_ui_driver";
    if (!ui) return [];
    const safeIssuer = suffix + "-" + requirement.issuer.replaceAll("_", "-");
    const actionTraces = requirement.checkpoints.map((checkpoint, index) => ({
      actionTraceId: "action_trace_" + safeIssuer + "-" + (index + 1),
      scenarioId: cell.scenarioId,
      checkpoint,
      intentKind: "task.visible-mutation-" + (index + 1),
      action: "click",
      target: { by: "testId", value: "control-" + (index + 1) },
      expectedHostCommands: 1,
    }));
    const actionCorrelations = actionTraces.map((trace, index) => ({
      actionTraceId: trace.actionTraceId,
      scenarioId: trace.scenarioId,
      checkpoint: trace.checkpoint,
      intentKind: trace.intentKind,
      uiIntentId: "ui_intent_" + safeIssuer + "-" + (index + 1),
      commandId: "command_" + safeIssuer + "-" + (index + 1),
      runtimeInstanceId: cell.lineage.runtimeInstanceId,
    }));
    return [[requirement.issuer, { actionTraces, actionCorrelations }]];
  }));
  const hostCommands = [...uiEvidence.values()].flatMap(({ actionCorrelations }) => (
    actionCorrelations.map(({ commandId, uiIntentId, intentKind, runtimeInstanceId }) => ({
      commandId,
      uiIntentId,
      intentKind,
      runtimeInstanceId,
      source: "authenticated_runtime_bridge",
    }))
  ));
  const streams = [];
  for (const requirement of cell.streamRequirements) {
    const safeIssuer = suffix + "-" + requirement.issuer.replaceAll("_", "-");
    const ledgerFile = safeIssuer + ".json";
    const acpIssuer = requirement.issuer === "opencode_acp_task_attestor"
      || requirement.issuer === "codex_acp_task_attestor"
      || requirement.issuer === "acp_meta_attestor";
    const roles = requirement.issuer === "acp_meta_attestor"
      ? ["meta"]
      : ["conductor", "publisher", "worker", "reviewer"];
    const hostGenerations = requirement.issuer === "acp_meta_attestor" ? [1] : [1, 2];
    const generations = acpIssuer
      ? hostGenerations.map((hostGeneration) => {
          const productionObservations = roles.map((role) =>
            productionObservation(cell, requirement.issuer, role, mutation, hostGeneration));
          if (mutation === "missing-acp-lifecycle" && hostGeneration === hostGenerations[0]) {
            productionObservations.shift();
          }
          const semanticFacts = acpSemanticFacts(cell, requirement.issuer, productionObservations);
          if (mutation === "missing-acp-semantic-fact" && hostGeneration === hostGenerations.at(-1)) {
            const workerProfileRevisionId = productionObservations.find(({ role }) => role === "worker")?.profileRevisionId;
            const missingIndex = semanticFacts.findIndex((fact) =>
              fact.profileRevisionId === workerProfileRevisionId && fact.kind === "restart_load_resume");
            if (missingIndex >= 0) semanticFacts.splice(missingIndex, 1);
          }
          return {
            hostGeneration,
            observedLineageDigest: observedLineage.canonicalDigest,
            semanticFacts,
            productionObservations,
          };
        })
      : undefined;
    const checkpointFacts = acpIssuer
      ? undefined
      : requirement.checkpoints.map((checkpoint) => ({
          checkpoint,
          event: "verified_fact",
          ...(mutation === "unknown-reference" ? { taskId: "task_not-observed-" + suffix } : {}),
        }));
    const ledger = {
      schemaVersion: acpIssuer ? 2 : 1,
      releaseRunId: matrix.releaseRunId,
      nonce: matrix.nonce,
      bundleCellId: cell.bundleCellId,
      scenarioId: cell.scenarioId,
      runtimeInstanceId: cell.lineage.runtimeInstanceId,
      ...(acpIssuer
        ? {
            issuer: requirement.issuer,
            finalizedHostGeneration: hostGenerations.at(-1),
            generations,
          }
        : {
            observedLineageDigest: observedLineage.canonicalDigest,
            checkpointFacts,
            environmentKeys: Object.keys(process.env).sort(),
            ...((acpTaskCell || acpMetaCell) && requirement.issuer === "runtime_host"
              ? { hostCommands }
              : {}),
          }),
    };
    const ledgerPath = path.join(args.output, ledgerFile);
    await writeFile(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
    await chmod(ledgerPath, 0o600);
    const ui = uiEvidence.get(requirement.issuer);
    streams.push({
      issuer: requirement.issuer,
      journeyId: "journey_" + suffix,
      outcome: "PASS",
      checkpoints: requirement.checkpoints,
      ledgerFile,
      observedLineageDigest: observedLineage.canonicalDigest,
      ...(ui ? ui : {}),
      ...(forgeAuthority ? { evidenceClass: "qualified_acp_provider" } : {}),
    });
  }
  const candidatePath = path.join(args.output, "candidate.json");
  await writeFile(candidatePath, JSON.stringify({
    schemaVersion: 1,
    releaseRunId: matrix.releaseRunId,
    nonce: matrix.nonce,
    bundleCellId: cell.bundleCellId,
    scenarioId: cell.scenarioId,
    lineage: cell.lineage,
    observedLineage,
    observedLineageDigest: observedLineage.canonicalDigest,
    streams,
  }), { mode: 0o600 });
  await chmod(candidatePath, 0o600);
}

function acpSemanticFacts(cell, issuer, observations) {
  const digest = (observation, kind) => "sha256:" + createHash("sha256")
    .update(cell.bundleCellId + "|" + issuer + "|" + observation.profileRevisionId
      + "|" + observation.processGenerationDigest + "|" + kind)
    .digest("hex");
  const make = (kind, observation) => ({
    kind,
    profileRevisionId: observation.profileRevisionId,
    processGenerationDigest: observation.processGenerationDigest,
    observationDigest: digest(observation, kind),
  });
  if (issuer === "acp_meta_attestor") {
    const observation = observations[0];
    return [
      make("independent_process", observation),
      make("no_tools", observation),
      make("no_cwd", observation),
      make("no_workspace", observation),
      make("strict_whole_final", observation),
      make("permission_rejected", observation),
      make("cold_reconcile", observation),
    ];
  }
  const facts = [];
  for (const observation of observations) {
    facts.push(
      make("actual_binding_generation", observation),
      make("prompt_receipt", observation),
      make("latest_final_terminal_pair", observation),
      make("restart_load_resume", observation),
    );
  }
  const conductor = observations.find(({ role }) => role === "conductor");
  const publisher = observations.find(({ role }) => role === "publisher");
  if (conductor) {
    facts.push(
      make("cancel_reconcile", conductor),
      make("scoped_mcp_call", conductor),
    );
  }
  if (publisher) facts.push(make("scoped_mcp_call", publisher));
  return facts;
}

function productionObservation(cell, issuer, role, mutation, hostGeneration) {
  const providerFamily = issuer === "codex_acp_task_attestor" ? "codex" : "opencode";
  const acpAgentKind = providerFamily === "codex" ? "codex_acp" : "native_acp";
  const stableDigest = (kind) => "sha256:" + createHash("sha256")
    .update(cell.bundleCellId + "|" + issuer + "|" + role + "|" + kind).digest("hex");
  const generationDigest = (kind) => "sha256:" + createHash("sha256")
    .update(cell.bundleCellId + "|" + issuer + "|" + role + "|host-generation-"
      + hostGeneration + "|" + kind).digest("hex");
  return {
    schemaVersion: 1,
    evidenceClass: issuer === "acp_meta_attestor" ? "qualified_acp_meta" : "qualified_acp_provider",
    productionLane: issuer,
    profileRevisionId: "profile_revision_" + issuer + "-" + role,
    providerFamily: mutation === "acp-lane-mismatch" ? "opencode" : providerFamily,
    acpAgentKind: mutation === "acp-lane-mismatch" ? "native_acp" : acpAgentKind,
    role,
    model: providerFamily + "-current/model-" + role,
    profileConfigurationDigest: stableDigest("profile-configuration"),
    resolutionSealDigest: stableDigest("resolution"),
    observedArtifactVersion: "current-observed-version",
    qualificationDigest: mutation === "cross-acp-qualification-reuse"
      ? "sha256:" + createHash("sha256")
        .update("shared-acp-qualification|" + role + "|" + hostGeneration).digest("hex")
      : generationDigest("qualification-identity"),
    processGenerationDigest: generationDigest("process-generation"),
    initialize: {
      protocolMajor: 1,
      agent: { name: providerFamily + "-acp", version: "current" },
      capabilities: ["session/create", "session/prompt"],
      extensions: [],
      capabilityFingerprint: stableDigest("initialize"),
    },
    qualificationProbeDigest: mutation === "acp-qualification-reuse"
      ? "sha256:" + "a".repeat(64)
      : stableDigest("qualification"),
    actualPrompt: {
      receiptObserved: true,
      finalObserved: true,
      terminalObserved: true,
      attemptCorrelationDigest: generationDigest("attempt"),
      lifecycleDigest: generationDigest("lifecycle"),
    },
    cleanup: {
      bindingReleaseConfirmed: true,
      processExitConfirmed: true,
      credentialCleanupConfirmed: true,
      capabilityCleanupConfirmed: true,
      receiptDigest: generationDigest("cleanup"),
    },
    productionReceiptDigest: generationDigest("production-receipt"),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") + "}";
  }
  return JSON.stringify(value);
}
