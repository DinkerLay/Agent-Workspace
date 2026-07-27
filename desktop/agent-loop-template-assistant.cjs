const crypto = require("node:crypto");
const { generateTaskDraft } = require("./task-draft-assistant.cjs");

const DEFAULT_MODEL = "opencode-go/deepseek-v4-flash";
const SEMANTIC_HANDOFF_GUIDANCE = [
  "Native Session answers are whole semantic materials. When a later Session needs one, the Conductor may select its durable result with contextRefs so Runtime supplies the exact answer rather than a Conductor paraphrase.",
  "If a Reviewer is present, its `pass`, `needs changes`, and critique are ordinary natural-language content in its completed result, not a Runtime status. For a factual, source, date, coverage, or contradiction gap, the Conductor should decide whether to send that exact Review result to an evidence-capable Session; after new evidence returns, it decides whether more review is useful. Publisher receives only the selected evidence and review material the Conductor judges relevant to a deliverable.",
  "This is decision guidance, not a required role order, automatic repair route, or completion gate.",
].join(" ");

/**
 * Template generation deliberately reuses the OpenCode task-draft assistant.
 * It asks the provider for a Conductor + native worker plan, then converts that
 * bounded plan into an unsaved Agent Loop Template. Saving remains an explicit
 * renderer action; this function never creates a Task or starts a Session.
 */
async function generateAgentLoopTemplate(input, dependencies = {}) {
  const generate = dependencies.generateTaskDraft ?? generateTaskDraft;
  const description = required(input?.description, "description");
  const cwd = required(input?.cwd, "cwd");
  const model = String(input?.model || DEFAULT_MODEL);
  const result = await generate({
    message: [
      "Generate a reusable Agent Loop Template, not a Task execution.",
      "The user will edit and explicitly save the result before it may be used.",
      "Plan one Conductor and native OpenCode Session Agent cards only. Do not create a workflow, graph, nodes, edges, scheduler, fixed role order, mandatory reviewer, or mandatory remediation route.",
      "Write a concise editable Conductor Charter: explain how the Conductor should use durable worker returns and user follow-ups to decide the next dispatch. Session answers are complete semantic materials: the Conductor may select an exact prior answer with contextRefs for a target Session instead of paraphrasing it. A Reviewer's pass or needs changes is normal natural-language content, not a route status. When it names a factual evidence gap, the Charter should guide the Conductor to decide whether a suitable evidence card needs the exact Review result; Publisher should receive only material the Conductor selects as ready for delivery. This is a decision preference, never an executable routing rule or completion gate.",
      "For each worker, return a role, instructions, and expected Markdown/text output. Keep MCP and Skills unrestricted unless the user explicitly requires a narrow capability.",
      "User's desired collaboration:",
      description,
    ].join("\n\n"),
    projectPath: cwd,
    projectName: input?.projectName,
    model,
  });

  if (!result?.ok) {
    throw new Error(result?.error || result?.assistantMessage || "opencode_template_generation_failed");
  }
  const plan = result.sessionPlan;
  if (!plan?.conductor || !Array.isArray(plan.workers) || !plan.workers.length) {
    throw new Error("opencode_template_generation_missing_session_plan");
  }

  const title = String(result.draft?.title || input?.name || describeName(description)).trim();
  const artifactPath = String(result.draft?.artifactPath || "").trim();
  const agents = plan.workers.slice(0, 8).map((worker, index) => ({
    id: uniqueId(worker.idSeed || worker.name || `agent-${index + 1}`, index),
    name: String(worker.name || `Session Agent ${index + 1}`).trim(),
    kind: inferCardKind(worker),
    role: String(worker.role || "Carry out bounded work dispatched by Conductor.").trim(),
    model: String(worker.model || model),
    mcp: [],
    skills: [],
    instructions: String(worker.instructions || "").trim(),
    expectedOutput: String(worker.expectedOutput || "Return the bounded result, evidence, artifact paths, and remaining risks.").trim(),
  }));
  return {
    template: {
      id: `loop-${slug(title)}-${crypto.randomUUID().slice(0, 6)}`,
      name: title.endsWith("Agent Loop") ? title : `${title} Agent Loop`,
      description: String(result.draft?.summary || result.assistantMessage || description).trim(),
      source: "generated",
      conductor: {
        role: String(plan.conductor.role || "Conductor").trim(),
        model: String(plan.conductor.model || model),
        charter: [
          String(
          plan.conductor.charter
          || plan.conductor.instructions
          || "Decide each next dispatch from the task goal, durable Session returns, and user follow-ups. Use the available cards as capabilities, not as a fixed route.",
          ).trim(),
          SEMANTIC_HANDOFF_GUIDANCE,
        ].filter(Boolean).join("\n\n"),
      },
      agents,
      limits: {
        maxConcurrentSessions: Math.max(1, Math.min(agents.length, 3)),
        maxDispatchesPerDecision: Math.max(1, Math.min(agents.length, 3)),
      },
      delivery: { artifactPath, ownerAgentId: "" },
    },
    assistantMessage: String(result.assistantMessage || "OpenCode 已生成可编辑的 Agent Loop 草案。").trim(),
    assumptions: Array.isArray(result.assumptions) ? result.assumptions.map(String).filter(Boolean) : [],
  };
}

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
