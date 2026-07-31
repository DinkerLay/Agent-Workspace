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
              { idSeed: "researcher", name: "Researcher", role: "Evidence research", instructions: "寻找来源", expectedOutput: "evidence.md" },
              { idSeed: "reviewer", name: "Reviewer", role: "Evidence review", instructions: "检查缺口", expectedOutput: "review.md" },
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
                        role: "Evidence collection",
                        model: "opencode-go/deepseek-v4-flash",
                        mcp: [],
                        skills: [],
                        instructions: "收集来源与证据。",
                        expectedOutput: "证据摘要。",
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
    assert.doesNotMatch(runInput.message, /"description": "模板适用场景"/);
    assert.equal(generated.template.name, "Research Delivery Agent Loop");
    assert.equal(generated.template.agents[0].kind, "researcher");
    assert.equal(generated.template.delivery.artifactPath, "docs/research/report.md");
    assert.equal(Object.hasOwn(generated.template.conductor, "reviewPolicy"), false);
    assert.deepEqual(generated.assumptions, ["由用户保存后才能使用"]);
  });
});
