const crypto = require("node:crypto");
const { runOpencode } = require("./opencode-runner.cjs");
const { parseOpencodeJsonValues } = require("./task-draft-assistant.cjs");

const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
const AUTONOMOUS_DISPATCH_GUIDANCE = "Decide each next dispatch from the task goal, durable Session returns, and user follow-ups. Use the available cards as capabilities, not as a fixed route.";
const SEMANTIC_HANDOFF_GUIDANCE = [
  "Native Session answers are whole semantic materials. When a later Session needs one, the Conductor may select its durable result with contextRefs so Runtime supplies the exact answer rather than a Conductor paraphrase.",
  "If a Reviewer is present, its `pass`, `needs changes`, and critique are ordinary natural-language content in its completed result, not a Runtime status. For a factual, source, date, coverage, or contradiction gap, the Conductor should decide whether to send that exact Review result to an evidence-capable Session; after new evidence returns, it decides whether more review is useful. Publisher receives only the selected evidence and review material the Conductor judges relevant to a deliverable.",
  "This is decision guidance, not a required role order, automatic repair route, or completion gate. Card labels never create a Runtime dispatch prerequisite.",
].join(" ");

/**
 * Template generation has its own Provider contract. A Template is not a Task
 * draft: it describes reusable Conductor and Session Agent capabilities, but
 * never creates a Task, starts a Session, or fixes a routing sequence.
 */
async function generateAgentLoopTemplate(input, dependencies = {}) {
  const brief = required(input?.brief, "brief");
  const cwd = required(input?.cwd, "cwd");
  const model = String(input?.model || DEFAULT_MODEL);
  const result = dependencies.generateTaskDraft
    ? await generateLegacyTaskDraftTemplate({ input, brief, cwd, model, generate: dependencies.generateTaskDraft })
    : await generateNativeTemplate({ input, brief, cwd, model, run: dependencies.runOpencode ?? runOpencode });

  return buildTemplateResult({ input, brief, model, result });
}

async function generateNativeTemplate({ input, brief, cwd, model, run }) {
  const runResult = await run({
    cwd,
    model,
    timeoutMs: input?.timeoutMs,
    message: buildAgentLoopTemplatePrompt({ brief, model }),
  });
  if (!runResult?.ok) {
    throw new Error(runResult?.error || runResult?.stderr || "opencode_template_generation_failed");
  }

  const generated = parseGeneratedTemplate(runResult.stdout);
  if (!generated) throw new Error("opencode_template_generation_invalid_json");
  return generated;
}

async function generateLegacyTaskDraftTemplate({ input, brief, cwd, model, generate }) {
  const result = await generate({
    message: brief,
    projectPath: cwd,
    projectName: input?.projectName,
    model,
  });
  if (!result?.ok) throw new Error(result?.error || result?.assistantMessage || "opencode_template_generation_failed");
  const plan = result.sessionPlan;
  if (!plan?.conductor || !Array.isArray(plan.workers) || !plan.workers.length) {
    throw new Error("opencode_template_generation_missing_session_plan");
  }
  return {
    name: String(result.draft?.title || input?.name || describeName(brief)).trim(),
    conductor: {
      ...plan.conductor,
      charter: String(plan.conductor?.charter || plan.conductor?.instructions || result.draft?.summary || result.assistantMessage || brief).trim(),
    },
    agents: plan.workers,
    delivery: { artifactPath: String(result.draft?.artifactPath || "").trim() },
    assumptions: Array.isArray(result.assumptions) ? result.assumptions : [],
    assistantMessage: result.assistantMessage,
  };
}

function buildTemplateResult({ input, brief, model, result }) {
  const title = String(result.name || input?.name || describeName(brief)).trim();
  const agents = result.agents.slice(0, 8).map((worker, index) => ({
    id: uniqueId(worker.id || worker.idSeed || worker.name || `agent-${index + 1}`, index),
    name: String(worker.name || `Session Agent ${index + 1}`).trim(),
    kind: normalizeCardKind(worker.kind) || inferCardKind(worker),
    role: String(worker.role || "Carry out bounded work dispatched by Conductor.").trim(),
    model: String(worker.model || model),
    mcp: stringList(worker.mcp),
    skills: stringList(worker.skills),
    instructions: String(worker.instructions || "").trim(),
    expectedOutput: String(worker.expectedOutput || "Return the bounded result, evidence, artifact paths, and remaining risks.").trim(),
  }));

  return {
    template: {
      id: `loop-${slug(title)}-${crypto.randomUUID().slice(0, 6)}`,
      name: title.endsWith("Agent Loop") ? title : `${title} Agent Loop`,
      source: "generated",
      conductor: {
        role: String(result.conductor.role || "Conductor").trim(),
        model: String(result.conductor.model || model),
        charter: [
          String(
          result.conductor.charter
          || result.conductor.instructions
          || result.assistantMessage
          || brief,
          ).trim(),
          AUTONOMOUS_DISPATCH_GUIDANCE,
          SEMANTIC_HANDOFF_GUIDANCE,
        ].filter(Boolean).join("\n\n"),
      },
      agents,
      limits: {
        maxConcurrentSessions: normalizeLimit(result.limits?.maxConcurrentSessions, agents.length),
        maxDispatchesPerDecision: normalizeLimit(result.limits?.maxDispatchesPerDecision, agents.length),
      },
      delivery: { artifactPath: String(result.delivery?.artifactPath || "").trim(), ownerAgentId: "" },
    },
    assistantMessage: String(result.assistantMessage || "OpenCode 已生成可编辑的 Agent Loop 草案。").trim(),
    assumptions: stringList(result.assumptions),
  };
}

function buildAgentLoopTemplatePrompt({ brief, model }) {
  return [
    "You are the Agent Loop Template Assistant for Agent Workspace.",
    "Generate a reusable editable Agent Loop Template. This is template design only: do not create a Task, run tools, edit files, create a workflow, graph, nodes, edges, scheduler, fixed role order, automatic reviewer, automatic remediation route, or completion gate.",
    "Return exactly one JSON object and no markdown or explanatory prose.",
    "The object must have this shape:",
    JSON.stringify({
      assistantMessage: "简短中文说明",
      template: {
        name: "可编辑模板名称",
        conductor: {
          role: "Conductor 的职责",
          model,
          charter: "唯一的模板级编排说明：写明适用任务、Session Agent 协作方式和 Conductor 根据任务目标、完整 durable Session 返回及用户跟进决定下一次派发的偏好。",
        },
        agents: [{
          id: "lowercase-kebab-case",
          name: "Session Agent 名称",
          kind: "researcher|reviewer|publisher|general",
          role: "单一能力说明",
          model,
          mcp: [],
          skills: [],
          instructions: "由 Conductor 派发边界清晰的工作；不自行派发其他 Agent。",
          expectedOutput: "Markdown 或文本结果、证据、产物路径与剩余风险。",
        }],
        limits: { maxConcurrentSessions: 3, maxDispatchesPerDecision: 3 },
        delivery: { artifactPath: "" },
      },
      assumptions: [],
    }, null, 2),
    "Rules: conductor.charter is the only Template-level human-readable orchestration field. It must fold the user's intended use, suitable task context, Session Agent collaboration, and Conductor decision preferences into one editable Charter. Do not emit a description or purpose field. All agents are native OpenCode Session Agents and are capabilities, not an execution sequence. Keep mcp and skills empty unless the user explicitly limits them (empty means unrestricted). The Conductor may select exact prior Session results with contextRefs instead of paraphrasing. A Reviewer's pass or needs changes is natural-language material; the Conductor decides whether to dispatch further evidence work and which complete materials to hand to a Publisher. Never emit a review policy or other Runtime prerequisite; every next dispatch remains a Conductor decision.",
    "User's desired collaboration:",
    brief,
  ].join("\n\n");
}

function parseGeneratedTemplate(stdout) {
  for (const value of parseOpencodeJsonValues(stdout)) {
    const payload = value?.template && typeof value.template === "object" ? value.template : value;
    const agents = Array.isArray(payload?.agents) ? payload.agents : Array.isArray(payload?.workers) ? payload.workers : [];
    if (!payload?.conductor || !agents.length) continue;
    const normalizedAgents = agents.map(normalizeAgent).filter(Boolean);
    if (!normalizedAgents.length) continue;
    return {
      name: stringValue(payload.name),
      conductor: normalizeConductor(payload.conductor),
      agents: normalizedAgents,
      limits: payload.limits && typeof payload.limits === "object" ? payload.limits : {},
      delivery: payload.delivery && typeof payload.delivery === "object" ? payload.delivery : {},
      assumptions: stringList(value?.assumptions),
      assistantMessage: stringValue(value?.assistantMessage),
    };
  }
  return undefined;
}

function normalizeConductor(value) {
  if (!value || typeof value !== "object") return {};
  return {
    role: stringValue(value.role),
    model: stringValue(value.model),
    charter: stringValue(value.charter || value.instructions),
  };
}

function normalizeAgent(value) {
  if (!value || typeof value !== "object") return undefined;
  const name = stringValue(value.name);
  const role = stringValue(value.role);
  return name && role ? value : undefined;
}

function normalizeCardKind(value) {
  return ["researcher", "reviewer", "publisher", "general"].includes(value) ? value : undefined;
}

function normalizeLimit(value, agentCount) {
  const numeric = Number(value);
  const fallback = Math.max(1, Math.min(agentCount, 3));
  return Number.isInteger(numeric) && numeric > 0 ? Math.min(numeric, Math.max(agentCount, 1)) : fallback;
}

function stringValue(value) { return typeof value === "string" ? value.trim() : ""; }
function stringList(value) { return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : []; }

function uniqueId(value, index) { return `${slug(value) || "agent"}${index ? `-${index + 1}` : ""}`; }
function inferCardKind(worker = {}) {
  const description = `${worker.idSeed || ""} ${worker.name || ""} ${worker.role || ""} ${worker.instructions || ""}`.toLowerCase();
  if (/(review|reviewer|validator|审查|校验|验收)/i.test(description)) return "reviewer";
  if (/(publish|publisher|consolidat|writer|author|synthesi[sz]|交付|整合|汇总|发布|撰写)/i.test(description)) return "publisher";
  if (/(research|search|analyst|researcher|调研|搜索|研究|分析)/i.test(description)) return "researcher";
  return "general";
}
function slug(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""); }
function describeName(value) { return String(value).trim().replace(/[。.!！?？].*$/s, "").slice(0, 72) || "Generated"; }
function required(value, field) { if (!String(value || "").trim()) throw new Error(`Agent Loop template generation requires ${field}.`); return String(value).trim(); }

module.exports = { generateAgentLoopTemplate };
