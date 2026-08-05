import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { generateAgentLoopTemplate } from "./agent-loop-template-assistant.cjs";

describe("Agent Loop Template Assistant", () => {
  it("turns one OpenCode-generated Session Plan into an unsaved editable Loop Template", async () => {
    const generated = await generateAgentLoopTemplate(
      { cwd: "/tmp", brief: "先研究，再复核，最后制作交付文档。" },
      {
        generateTaskDraft: async () => ({
          ok: true,
          assistantMessage: "已生成草案。",
          draft: { title: "Research delivery", summary: "收集证据并形成可交付报告。", artifactPath: "docs/report.md" },
          assumptions: ["默认使用原生工具"],
          sessionPlan: {
            conductor: { role: "Task owner", model: "opencode-go/deepseek-v4-flash" },
            workers: [
              {
                idSeed: "researcher",
                name: "Researcher",
                dispatchProfile: { title: "Evidence research", description: "Collect independently verifiable evidence when the Conductor needs source-backed findings." },
                workerSystemPrompt: "Find primary sources and record dates, citations, and uncertainty.",
              },
              {
                idSeed: "reviewer",
                name: "Reviewer",
                dispatchProfile: { title: "Evidence review", description: "Assess source quality and material gaps after evidence is available." },
                workerSystemPrompt: "Review only the supplied evidence and describe gaps without inventing facts.",
              },
            ],
          },
        }),
      },
    );
    assert.equal(generated.template.source, "generated");
    assert.equal(Object.hasOwn(generated.template, "description"), false);
    assert.equal(generated.template.agents.length, 2);
    assert.equal(generated.template.agents[0].model, "opencode-go/deepseek-v4-flash");
    assert.deepEqual(generated.template.agents[0].mcp, []);
    assert.deepEqual(generated.template.agents[0].dispatchProfile, {
      title: "Evidence research",
      description: "Collect independently verifiable evidence when the Conductor needs source-backed findings.",
    });
    assert.equal(generated.template.agents[0].workerSystemPrompt, "Find primary sources and record dates, citations, and uncertainty.");
    assert.equal(Object.hasOwn(generated.template.agents[0], "instructions"), false);
    assert.equal(generated.template.delivery.artifactPath, "docs/report.md");
    assert.equal(generated.template.delivery.ownerAgentId, "");
    assert.match(generated.template.conductor.charter, /durable Session returns/i);
    assert.match(generated.template.conductor.charter, /contextRefs/i);
    assert.match(generated.template.conductor.charter, /not a Runtime status/i);
    assert.match(generated.template.conductor.charter, /not a required role order/i);
    assert.equal(Object.hasOwn(generated.template.conductor, "reviewPolicy"), false);
    assert.deepEqual(generated.assumptions, ["默认使用原生工具"]);
  });

  it("uses a dedicated native OpenCode Template contract instead of the Task Draft contract", async () => {
    let runInput;
    const generated = await generateAgentLoopTemplate(
      { cwd: "/tmp", brief: "并行研究产品资料，再按需要复核与交付。" },
      {
        runOpencode: async (input) => {
          runInput = input;
          return ({
          ok: true,
          stdout: [
            JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
            JSON.stringify({
              type: "text",
              part: {
                type: "text",
                text: JSON.stringify({
                  assistantMessage: "已生成可编辑 Loop 模板。",
                  template: {
                    name: "Research Delivery",
                    conductor: {
                      role: "Loop decision maker",
                      model: "opencode-go/deepseek-v4-flash",
                      charter: "读取完整返回后决定下一次派发。",
                    },
                    agents: [
                      {
                        id: "researcher",
                        name: "Researcher",
                        kind: "researcher",
                        model: "opencode-go/deepseek-v4-flash",
                        mcp: [],
                        skills: [],
                        dispatchProfile: {
                          title: "Evidence collection",
                          description: "Use for independent source collection and factual verification.",
                        },
                        workerSystemPrompt: "收集来源与证据，标记日期和不确定性。",
                      },
                    ],
                    limits: { maxConcurrentSessions: 1, maxDispatchesPerDecision: 1 },
                    delivery: { artifactPath: "docs/research/report.md" },
                  },
                  assumptions: ["由用户保存后才能使用"],
                }),
              },
            }),
          ].join("\n"),
          });
        },
      },
    );

    assert.match(runInput.message, /Agent Loop Template Assistant/);
    assert.doesNotMatch(runInput.message, /Task Draft Assistant/);
    assert.match(runInput.message, /only Template-level human-readable orchestration field/);
    assert.match(runInput.message, /dispatchProfile plus workerSystemPrompt/);
    assert.doesNotMatch(runInput.message, /"instructions": "由 Conductor/);
    assert.doesNotMatch(runInput.message, /"description": "模板适用场景"/);
    assert.equal(generated.template.name, "Research Delivery Agent Loop");
    assert.equal(generated.template.agents[0].kind, "researcher");
    assert.equal(generated.template.delivery.artifactPath, "docs/research/report.md");
    assert.equal(Object.hasOwn(generated.template.conductor, "reviewPolicy"), false);
    assert.deepEqual(generated.assumptions, ["由用户保存后才能使用"]);
  });

  it("rejects an old combined Card response instead of silently reclassifying its instructions", async () => {
    await assert.rejects(
      generateAgentLoopTemplate(
        { cwd: "/tmp", brief: "生成调研模板" },
        {
          runOpencode: async () => ({
            ok: true,
            stdout: JSON.stringify({
              template: {
                name: "Legacy shape",
                conductor: { role: "Conductor", model: "opencode-go/deepseek-v4-flash", charter: "Decide." },
                agents: [{ id: "researcher", name: "Researcher", role: "Research", instructions: "Find sources." }],
              },
            }),
          }),
        },
      ),
      /opencode_template_generation_invalid_json/,
    );
  });
});
