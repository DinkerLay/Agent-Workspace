import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { generateAgentLoopTemplate } from "./agent-loop-template-assistant.cjs";

describe("Agent Loop Template Assistant", () => {
  it("turns one OpenCode-generated Session Plan into an unsaved editable Loop Template", async () => {
    const generated = await generateAgentLoopTemplate(
      { cwd: "/tmp", description: "先研究，再复核，最后制作交付文档。" },
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
    assert.equal(generated.template.agents.length, 2);
    assert.equal(generated.template.agents[0].model, "opencode-go/deepseek-v4-flash");
    assert.deepEqual(generated.template.agents[0].mcp, []);
    assert.equal(generated.template.delivery.artifactPath, "docs/report.md");
    assert.equal(generated.template.delivery.ownerAgentId, "");
    assert.match(generated.template.conductor.charter, /durable Session returns/i);
    assert.match(generated.template.conductor.charter, /contextRefs/i);
    assert.match(generated.template.conductor.charter, /not a Runtime status/i);
    assert.match(generated.template.conductor.charter, /not a required role order/i);
    assert.deepEqual(generated.assumptions, ["默认使用原生工具"]);
  });
});
