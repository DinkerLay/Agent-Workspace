const { runOpencode } = require("./opencode-runner.cjs");

const defaultModel = "opencode-go/deepseek-v4-flash";
const validTemplateIds = new Set(["research", "product-logic", "spec-plan", "implementation", "debug-fix"]);

function buildTaskDraftPrompt(input) {
  const currentDraft = input.currentDraft ? JSON.stringify(input.currentDraft, null, 2) : "null";
  const projectName = input.projectName || basename(input.projectPath) || "Workspace";

  return [
    "You are Task Draft Assistant for Agent Workspace.",
    "Convert the user's natural-language task request into strict JSON only.",
    "Do not start tools, do not edit files, do not execute commands, and do not create tasks.",
    "",
    "Available templateId values:",
    "- research: research task, evidence/report oriented",
    "- product-logic: product interaction or product logic task",
    "- spec-plan: spec or implementation plan task",
    "- implementation: code implementation task",
    "- debug-fix: bug reproduction and fix task",
    "",
    "Return strict JSON with this shape:",
    JSON.stringify(
      {
        assistantMessage: "短中文说明",
        draft: {
          projectPath: input.projectPath,
          projectName,
          title: "任务标题",
          summary: "任务目标、事实、交付条件",
          templateId: "research",
          model: input.model || defaultModel,
          labels: ["research"],
          artifactPath: "docs/research/task-report.md",
          outputHints: ["md report"],
          agentHints: ["Conductor"],
        },
        sessionPlan: {
          templateId: "research",
          defaultModel: input.model || defaultModel,
          conductor: {
            idSeed: "conductor",
            name: "Conductor",
            role: "Research coordinator",
            provider: "opencode",
            model: input.model || defaultModel,
            instructions:
              "任务负责人。只管主线、派发、读取结果和收口判断；不要替代 worker 写 research/review/spec/plan 产物。",
          },
          workers: [
            {
              idSeed: "researcher",
              name: "Researcher",
              role: "Evidence collector",
              provider: "opencode",
              model: input.model || defaultModel,
              instructions: "独立调研、收集证据、写 research 产物。",
              expectedOutput: "docs/research/ 下的调研证据或报告片段。",
            },
            {
              idSeed: "reviewer",
              name: "Reviewer",
              role: "Source challenge",
              provider: "opencode",
              model: input.model || defaultModel,
              instructions: "复核来源质量、指出缺口和需要返工的点。",
              expectedOutput: "review 结果，明确 pass / needs changes。",
            },
          ],
          routePolicy: {
            allowedTargets: ["Researcher", "Reviewer"],
            notes: [
              "Conductor 先派 Researcher。",
              "Researcher 返回后派 Reviewer。",
              "Reviewer 要求修改时，把完整 review 文本派回对应 worker，再让 Reviewer 二次复核。",
              "Reviewer 明确通过后 Conductor 才能收口。",
            ],
          },
          workflow: [
            "dispatch Researcher",
            "read Researcher result",
            "dispatch Reviewer",
            "route fixes if needed",
            "final task-level consolidation after review pass",
          ],
          deliverables: ["docs/research/ report", "docs/superworks/spec/ clues", "docs/superworks/plans/ clues"],
        },
        draftPatch: null,
        sessionPlanPatch: null,
        missingFields: [],
        assumptions: [],
      },
      null,
      2,
    ),
    "",
    "Rules:",
    "- Use draft for initial generation when currentDraft is null.",
    "- Use draftPatch and/or sessionPlanPatch for follow-up edits when currentDraft exists.",
    "- If a follow-up only changes Session Agent Plan, draftPatch may be null.",
    "- sessionPlanPatch must be the complete updated execution plan, including conductor and all worker sessions.",
    "- If the user gives an absolute project path, put it in projectPath and derive projectName from the folder name unless specified.",
    "- If unsure, keep the existing currentDraft field and add the uncertainty to missingFields.",
    "- The model should default to opencode-go/deepseek-v4-flash unless the user asks otherwise.",
    "- labels must be concise lowercase tags.",
    "- Put research/report outputs under docs/research/.",
    "- Put product specs under docs/superworks/spec/ and implementation plans under docs/superworks/plans/.",
    "- For initial generation, always return sessionPlan. It is the editable execution plan for Conductor and worker sessions.",
    "- For follow-up edits, return sessionPlanPatch when the session plan changes.",
    "- sessionPlan.conductor is the task owner. sessionPlan.workers are provider-native sessions that do role-owned work.",
    "- If the user asks for multiple independent agents, create multiple worker entries with distinct idSeed values.",
    "- Put task-specific routing and loop rules in sessionPlan.routePolicy.notes and sessionPlan.workflow.",
    "- Output JSON only; no markdown wrapper unless unavoidable.",
    "",
    "Current project:",
    JSON.stringify({ projectPath: input.projectPath, projectName }, null, 2),
    "",
    "Current draft:",
    currentDraft,
    "",
    "User message:",
    input.message,
  ].join("\n");
}

async function generateTaskDraft(input, dependencies = {}) {
  const runner = dependencies.runOpencode || runOpencode;
  const model = input.model || defaultModel;
  const projectPath = input.projectPath;
  const prompt = buildTaskDraftPrompt({ ...input, model });
  const runResult = await runner({
    cwd: projectPath,
    message: prompt,
    model,
    timeoutMs: input.timeoutMs,
  });

  if (!runResult.ok) {
    return {
      ok: false,
      assistantMessage: "opencode 生成任务配置失败。",
      missingFields: [],
      assumptions: [],
      command: runResult.command,
      cwd: runResult.cwd,
      raw: runResult.stdout,
      error: runResult.error || runResult.stderr || "opencode run failed",
    };
  }

  const parsed = parseTaskDraftAssistantOutput(runResult.stdout);
  if (!parsed.ok) {
    const localPlanEdit = buildLocalSessionPlanEdit({ ...input, model });
    if (localPlanEdit) {
      return {
        ...localPlanEdit,
        command: runResult.command,
        cwd: runResult.cwd,
        raw: runResult.stdout,
      };
    }
  }
  return {
    ...parsed,
    command: runResult.command,
    cwd: runResult.cwd,
    raw: runResult.stdout,
  };
}

function buildLocalSessionPlanEdit(input) {
  const currentPlan = normalizeSessionPlan(input.currentDraft?.sessionPlan);
  if (!currentPlan) return undefined;

  const message = String(input.message || "");
  if (!isAddSessionAgentIntent(message)) return undefined;

  const requestedWorker = inferRequestedWorker(message);
  const existingNames = currentPlan.workers.map((worker) => worker.name).filter(Boolean);
  const name = uniqueWorkerName(requestedWorker.baseName, existingNames);
  const model = currentPlan.defaultModel || currentPlan.conductor.model || input.model || defaultModel;
  const worker = {
    idSeed: slugify(name),
    name,
    role: requestedWorker.role,
    provider: currentPlan.conductor.provider || "opencode",
    model,
    accent: requestedWorker.accent,
    instructions: requestedWorker.instructions,
    expectedOutput: requestedWorker.expectedOutput,
  };
  const workers = [...currentPlan.workers, worker];
  const routeNotes = [
    ...(currentPlan.routePolicy?.notes || []),
    `${name} 是用户追加的 session agent，Conductor 可按任务需要派发独立工作。`,
  ];
  const sessionPlanPatch = normalizeSessionPlan({
    ...currentPlan,
    defaultModel: model,
    workers,
    routePolicy: {
      ...currentPlan.routePolicy,
      allowedTargets: workers.map((item) => item.name).filter(Boolean),
      notes: [...new Set(routeNotes)],
    },
  });

  if (!sessionPlanPatch) return undefined;

  return {
    ok: true,
    assistantMessage: `已增加 ${name} session agent。`,
    sessionPlanPatch,
    missingFields: [],
    assumptions: [],
  };
}

function isAddSessionAgentIntent(message) {
  const lower = message.toLowerCase();
  const hasAddVerb = /(增加|新增|添加|加一个|再加|add|create|new)/i.test(message);
  const hasSessionTarget = /(session\s*agent|session|worker|agent|researcher|reviewer|executor|planner|qa|调研|研究|搜索|复核|审查|执行|实现|规划|验证)/i.test(lower);
  return hasAddVerb && hasSessionTarget;
}

function inferRequestedWorker(message) {
  const lower = message.toLowerCase();
  if (/(reviewer|review|复核|审查|评审)/i.test(lower)) {
    return {
      baseName: "Reviewer",
      role: "Source challenge",
      accent: "#be123c",
      instructions: "复核来源质量、结论可靠性和交付物缺口，明确 pass 或 needs changes。",
      expectedOutput: "review 结果，包含通过结论或需要返工的完整意见。",
    };
  }
  if (/(executor|implement|执行|实现|修改代码|代码)/i.test(lower)) {
    return {
      baseName: "Executor",
      role: "Implementation",
      accent: "#0f766e",
      instructions: "按 Conductor 派发的实现任务修改代码，并记录验证结果。",
      expectedOutput: "代码改动摘要、验证结果和风险说明。",
    };
  }
  if (/(planner|plan|spec|规划|方案|计划)/i.test(lower)) {
    return {
      baseName: "Planner",
      role: "Plan keeper",
      accent: "#4f46e5",
      instructions: "整理需求、约束和实现计划，输出可执行的 spec/plan 线索。",
      expectedOutput: "spec/plan 建议、关键决策和待确认问题。",
    };
  }
  if (/(qa|test|验证|测试)/i.test(lower)) {
    return {
      baseName: "QA",
      role: "Verification",
      accent: "#b45309",
      instructions: "验证目标行为、复现问题并记录测试证据。",
      expectedOutput: "验证步骤、测试结果和阻塞点。",
    };
  }
  return {
    baseName: "Researcher",
    role: /(独立|parallel|并行|搜索|search)/i.test(lower) ? "Independent search" : "Evidence collector",
    accent: "#2563eb",
    instructions: "独立搜索和收集证据，按 Conductor 派发的范围输出明确结果。",
    expectedOutput: "调研发现、来源链接、证据摘要和未解决问题。",
  };
}

function uniqueWorkerName(baseName, existingNames) {
  const used = new Set(existingNames);
  if (!used.has(baseName)) return baseName;
  const suffixes = "BCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  for (const suffix of suffixes) {
    const candidate = `${baseName} ${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${baseName} ${Date.now()}`;
}

function slugify(value) {
  return String(value || "worker")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "worker";
}

function parseTaskDraftAssistantOutput(stdout) {
  const candidates = extractJsonCandidates(stdout);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const result = normalizeAssistantResult(parsed);
      if (result.ok) return result;
    } catch {
      // Try the next candidate.
    }
  }

  return {
    ok: false,
    assistantMessage: "opencode 没有返回可用的任务配置 JSON。",
    missingFields: [],
    assumptions: [],
    error: "Unable to parse task draft assistant output.",
  };
}

function normalizeAssistantResult(value) {
  const nested = unwrapPotentialMessage(value);
  const payload = nested && typeof nested === "object" ? nested : value;
  const draft = normalizeDraft(payload.draft);
  const draftPatch = normalizeDraft(payload.draftPatch);
  const sessionPlan = normalizeSessionPlan(payload.sessionPlan);
  const sessionPlanPatch = normalizeSessionPlan(payload.sessionPlanPatch);
  const hasUsablePayload = Boolean(draft || draftPatch || sessionPlan || sessionPlanPatch);
  const assistantMessage =
    typeof payload.assistantMessage === "string" && payload.assistantMessage.trim()
      ? payload.assistantMessage.trim()
      : hasUsablePayload
        ? "已生成任务配置。"
        : "";

  if (!assistantMessage || !hasUsablePayload) {
    return {
      ok: false,
      assistantMessage: "opencode 没有返回可用的任务配置 JSON。",
      missingFields: [],
      assumptions: [],
      error: "Missing assistantMessage and task draft or session plan.",
    };
  }

  return {
    ok: true,
    assistantMessage,
    ...(draft ? { draft } : {}),
    ...(draftPatch ? { draftPatch } : {}),
    ...(sessionPlan ? { sessionPlan } : {}),
    ...(sessionPlanPatch ? { sessionPlanPatch } : {}),
    missingFields: arrayOfStrings(payload.missingFields),
    assumptions: arrayOfStrings(payload.assumptions),
  };
}

function unwrapPotentialMessage(value) {
  if (!value || typeof value !== "object") return undefined;
  const text =
    value.content ||
    value.text ||
    value.message ||
    value.output ||
    value.part?.text ||
    value.part?.content ||
    value.data?.content ||
    value.data?.text ||
    value.result;
  if (typeof text !== "string") return undefined;
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Ignore invalid nested payload.
    }
  }
  return undefined;
}

function normalizeDraft(value) {
  if (!value || typeof value !== "object") return undefined;
  const draft = {};
  setString(draft, "projectPath", value.projectPath);
  setString(draft, "projectName", value.projectName);
  setString(draft, "title", value.title);
  setString(draft, "summary", value.summary);
  setString(draft, "model", value.model);
  setString(draft, "artifactPath", value.artifactPath);
  const templateId = typeof value.templateId === "string" ? value.templateId.trim() : "";
  if (validTemplateIds.has(templateId)) draft.templateId = templateId;
  const labels = arrayOfStrings(value.labels);
  if (labels.length) draft.labels = labels;
  const outputHints = arrayOfStrings(value.outputHints);
  if (outputHints.length) draft.outputHints = outputHints;
  const agentHints = arrayOfStrings(value.agentHints);
  if (agentHints.length) draft.agentHints = agentHints;
  return Object.keys(draft).length ? draft : undefined;
}

function normalizeSessionPlan(value) {
  if (!value || typeof value !== "object") return undefined;
  const conductor = normalizePlanSession(value.conductor);
  const workers = Array.isArray(value.workers)
    ? value.workers.map(normalizePlanSession).filter(Boolean)
    : [];
  if (!conductor || !workers.length) return undefined;

  const plan = {
    conductor,
    workers,
  };
  setString(plan, "templateId", value.templateId);
  setString(plan, "defaultModel", value.defaultModel);
  const routePolicy = {};
  const allowedTargets = arrayOfStrings(value.routePolicy?.allowedTargets);
  if (allowedTargets.length) routePolicy.allowedTargets = allowedTargets;
  const routeNotes = arrayOfStrings(value.routePolicy?.notes);
  if (routeNotes.length) routePolicy.notes = routeNotes;
  if (Object.keys(routePolicy).length) plan.routePolicy = routePolicy;
  const workflow = arrayOfStrings(value.workflow);
  if (workflow.length) plan.workflow = workflow;
  const deliverables = arrayOfStrings(value.deliverables);
  if (deliverables.length) plan.deliverables = deliverables;
  const notes = arrayOfStrings(value.notes);
  if (notes.length) plan.notes = notes;
  return plan;
}

function normalizePlanSession(value) {
  if (!value || typeof value !== "object") return undefined;
  const session = {};
  setString(session, "idSeed", value.idSeed);
  setString(session, "name", value.name);
  setString(session, "role", value.role);
  setString(session, "provider", value.provider);
  setString(session, "model", value.model);
  setString(session, "accent", value.accent);
  setString(session, "instructions", value.instructions);
  setString(session, "expectedOutput", value.expectedOutput);
  return session.name && session.role ? session : undefined;
}

function extractJsonCandidates(text) {
  if (!text) return [];
  const candidates = [];
  const sources = [text];
  const jsonlText = extractOpencodeTextParts(text);
  if (jsonlText) sources.push(jsonlText);

  for (const source of sources) {
    const trimmed = source.trim();
    if (trimmed) candidates.push(trimmed);

    const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fenceMatch;
    while ((fenceMatch = fencePattern.exec(source))) {
      candidates.push(fenceMatch[1].trim());
    }

    for (const line of source.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).reverse()) {
      if (line.startsWith("{") && line.endsWith("}")) candidates.push(line);
    }

    const objectCandidate = extractFirstJsonObject(source);
    if (objectCandidate) candidates.push(objectCandidate);
  }

  return [...new Set(candidates)];
}

function extractOpencodeTextParts(text) {
  const parts = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const event = JSON.parse(trimmed);
      const partText = event?.part?.text;
      if (typeof partText === "string") parts.push(partText);
    } catch {
      // Non-JSON diagnostic lines are handled by the generic extractors.
    }
  }
  return parts.join("");
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function setString(target, key, value) {
  if (typeof value !== "string") return;
  const normalized = value.trim();
  if (normalized) target[key] = normalized;
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function basename(value) {
  return String(value || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean)
    .pop() || "";
}

module.exports = {
  buildTaskDraftPrompt,
  generateTaskDraft,
  parseTaskDraftAssistantOutput,
};
