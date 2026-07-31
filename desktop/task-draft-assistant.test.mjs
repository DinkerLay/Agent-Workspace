import { describe, expect, it } from "vitest";
import { buildTaskDraftPrompt, generateTaskDraft, parseTaskDraftAssistantOutput } from "./task-draft-assistant.cjs";

describe("desktop task draft assistant", () => {
  it("builds a schema-bound prompt for opencode headless task draft generation", () => {
    const prompt = buildTaskDraftPrompt({
      message: "在 /tmp/project 调研 claude dynamic workflow 机制",
      projectPath: "/tmp/project",
      projectName: "project",
      model: "opencode-go/deepseek-v4-flash",
    });

    expect(prompt).toContain("Task Draft Assistant");
    expect(prompt).toContain("strict JSON");
    expect(prompt).toContain("在 /tmp/project 调研 claude dynamic workflow 机制");
    expect(prompt).toContain("\"templateId\"");
    expect(prompt).toContain("\"sessionPlan\"");
    expect(prompt).toContain("research");
    expect(prompt).toContain("product-logic");
    expect(prompt).toContain("sessionPlanPatch");
  });

  it("parses a JSON task draft from opencode stdout", () => {
    const result = parseTaskDraftAssistantOutput(`noise
\`\`\`json
{
  "assistantMessage": "已生成调研任务配置。",
  "draft": {
    "projectPath": "/tmp/project",
    "projectName": "project",
    "title": "调研 claude dynamic workflow 机制",
    "summary": "调研机制。",
    "templateId": "research",
    "model": "opencode-go/deepseek-v4-flash",
    "labels": ["research", "claude"]
  },
  "missingFields": [],
  "assumptions": ["使用默认模型"]
}
\`\`\``);

    expect(result).toEqual({
      ok: true,
      assistantMessage: "已生成调研任务配置。",
      draft: {
        projectPath: "/tmp/project",
        projectName: "project",
        title: "调研 claude dynamic workflow 机制",
        summary: "调研机制。",
        templateId: "research",
        model: "opencode-go/deepseek-v4-flash",
        labels: ["research", "claude"],
      },
      missingFields: [],
      assumptions: ["使用默认模型"],
    });
  });

  it("parses fenced draft JSON from opencode format-json text events", () => {
    const result = parseTaskDraftAssistantOutput(
      [
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text: "```json\n{\"assistantMessage\":\"已生成配置。\",\"draft\":{\"projectPath\":\"/tmp/project\",\"projectName\":\"project\",\"title\":\"调研 workflow\",\"summary\":\"调研机制。\",\"templateId\":\"research\",\"model\":\"opencode-go/deepseek-v4-flash\",\"labels\":[\"research\"]},\"missingFields\":[],\"assumptions\":[]}\n```",
          },
        }),
        JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      assistantMessage: "已生成配置。",
      draft: {
        title: "调研 workflow",
        templateId: "research",
      },
    });
  });

  it("parses an editable session plan with multiple worker sessions", () => {
    const result = parseTaskDraftAssistantOutput(JSON.stringify({
      assistantMessage: "已生成调研任务和 session 编排。",
      draft: {
        projectPath: "/tmp/project",
        projectName: "project",
        title: "双路调研 workflow",
        summary: "两个 researcher 独立调研，再 review。",
        templateId: "research",
        model: "opencode-go/deepseek-v4-flash",
        labels: ["research"],
      },
      sessionPlan: {
        templateId: "research",
        defaultModel: "opencode-go/deepseek-v4-flash",
        conductor: {
          idSeed: "conductor",
          name: "Conductor",
          role: "Research coordinator",
          instructions: "先派两个 Researcher，再派 Reviewer。",
        },
        workers: [
          {
            idSeed: "researcher-a",
            name: "Researcher A",
            role: "Official docs",
            expectedOutput: "official docs notes",
          },
          {
            idSeed: "researcher-b",
            name: "Researcher B",
            role: "Ecosystem comparison",
            expectedOutput: "comparison notes",
          },
          {
            idSeed: "reviewer",
            name: "Reviewer",
            role: "Source challenge",
            expectedOutput: "review result",
          },
        ],
        routePolicy: {
          allowedTargets: ["Researcher A", "Researcher B", "Reviewer"],
          notes: ["Reviewer 通过后才能收口"],
        },
      },
      missingFields: [],
      assumptions: [],
    }));

    expect(result).toMatchObject({
      ok: true,
      sessionPlan: {
        workers: [
          { idSeed: "researcher-a", name: "Researcher A" },
          { idSeed: "researcher-b", name: "Researcher B" },
          { idSeed: "reviewer", name: "Reviewer" },
        ],
        routePolicy: {
          allowedTargets: ["Researcher A", "Researcher B", "Reviewer"],
        },
      },
    });
  });

  it("accepts a follow-up output that only patches the session plan", () => {
    const result = parseTaskDraftAssistantOutput(JSON.stringify({
      assistantMessage: "已增加一个独立 Researcher session。",
      draftPatch: null,
      sessionPlanPatch: {
        templateId: "research",
        defaultModel: "opencode-go/deepseek-v4-flash",
        conductor: {
          idSeed: "conductor",
          name: "Conductor",
          role: "Research coordinator",
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
          instructions: "任务负责人，只派发、读取结果和收口判断。",
        },
        workers: [
          {
            idSeed: "researcher",
            name: "Researcher",
            role: "Evidence collector",
            provider: "opencode",
            model: "opencode-go/deepseek-v4-flash",
            instructions: "独立调研并写 research 产物。",
          },
          {
            idSeed: "researcher-b",
            name: "Researcher B",
            role: "Independent search",
            provider: "opencode",
            model: "opencode-go/deepseek-v4-flash",
            instructions: "独立搜索补充证据。",
          },
          {
            idSeed: "reviewer",
            name: "Reviewer",
            role: "Source challenge",
            provider: "opencode",
            model: "opencode-go/deepseek-v4-flash",
            instructions: "复核来源质量。",
          },
        ],
        routePolicy: {
          allowedTargets: ["Researcher", "Researcher B", "Reviewer"],
          notes: ["Conductor 可以把独立调研任务分别派给两个 Researcher。"],
        },
      },
      missingFields: [],
      assumptions: [],
    }));

    expect(result).toMatchObject({
      ok: true,
      assistantMessage: "已增加一个独立 Researcher session。",
      sessionPlanPatch: {
        workers: [
          { idSeed: "researcher", name: "Researcher" },
          { idSeed: "researcher-b", name: "Researcher B" },
          { idSeed: "reviewer", name: "Reviewer" },
        ],
        routePolicy: {
          allowedTargets: ["Researcher", "Researcher B", "Reviewer"],
        },
      },
    });
  });

  it("parses draft JSON when opencode format-json text events are split", () => {
    const result = parseTaskDraftAssistantOutput(
      [
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text:
              "```json\n{\"assistantMessage\":\"已生成配置。\",\"draft\":{\"projectPath\":\"/tmp/project\",\"projectName\":\"project\",",
          },
        }),
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text:
              "\"title\":\"调研 workflow\",\"summary\":\"调研机制。\",\"templateId\":\"research\",\"model\":\"opencode-go/deepseek-v4-flash\",\"labels\":[\"research\"]},\"missingFields\":[],\"assumptions\":[]}\n```",
          },
        }),
        JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      assistantMessage: "已生成配置。",
      draft: {
        title: "调研 workflow",
        model: "opencode-go/deepseek-v4-flash",
      },
    });
  });

  it("finds the later assistant JSON when transport events contain earlier balanced objects", () => {
    const result = parseTaskDraftAssistantOutput(
      [
        JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
        JSON.stringify({ type: "tool", part: { type: "tool", state: { input: { unrelated: true } } } }),
        JSON.stringify({
          type: "text",
          part: {
            type: "text",
            text: "Generated:\n{\"assistantMessage\":\"已生成配置。\",\"sessionPlan\":{\"conductor\":{\"name\":\"Conductor\",\"role\":\"Coordinator\"},\"workers\":[{\"name\":\"Researcher\",\"role\":\"Evidence\"}]}}",
          },
        }),
      ].join("\n"),
    );

    expect(result).toMatchObject({
      ok: true,
      sessionPlan: {
        conductor: { name: "Conductor" },
        workers: [{ name: "Researcher" }],
      },
    });
  });

  it("calls opencode run through the existing one-shot runner and returns parsed draft JSON", async () => {
    const calls = [];

    const result = await generateTaskDraft(
      {
        message: "调研 claude dynamic workflow 机制",
        projectPath: "/tmp/project",
        projectName: "project",
        model: "opencode-go/deepseek-v4-flash",
      },
      {
        runOpencode: async (input) => {
          calls.push(input);
          return {
            ok: true,
            command: "opencode run --format json",
            cwd: input.cwd,
            model: input.model,
            stdout: JSON.stringify({
              assistantMessage: "已生成配置。",
              draft: {
                projectPath: "/tmp/project",
                projectName: "project",
                title: "调研 claude dynamic workflow 机制",
                summary: "调研机制。",
                templateId: "research",
                model: "opencode-go/deepseek-v4-flash",
                labels: ["research", "claude"],
              },
              missingFields: [],
              assumptions: [],
            }),
            stderr: "",
            exitCode: 0,
            durationMs: 1,
          };
        },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      cwd: "/tmp/project",
      model: "opencode-go/deepseek-v4-flash",
    });
    expect(calls[0].message).toContain("Task Draft Assistant");
    expect(result).toMatchObject({
      ok: true,
      draft: {
        title: "调研 claude dynamic workflow 机制",
        templateId: "research",
      },
    });
  });

  it("adds a session agent from a clear follow-up intent when opencode output is not usable JSON", async () => {
    const currentDraft = {
      projectPath: "/tmp/project",
      projectName: "project",
      title: "调研 Claude Dynamic Workflow 机制",
      summary: "调研 Claude Dynamic Workflow 机制。",
      templateId: "research",
      model: "opencode-go/deepseek-v4-flash",
      labels: ["research", "claude"],
      sessionPlan: {
        templateId: "research",
        defaultModel: "opencode-go/deepseek-v4-flash",
        conductor: {
          idSeed: "conductor",
          name: "Conductor",
          role: "Research coordinator",
          provider: "opencode",
          model: "opencode-go/deepseek-v4-flash",
          instructions: "任务负责人，只派发、读取结果和收口判断。",
        },
        workers: [
          {
            idSeed: "researcher",
            name: "Researcher",
            role: "Evidence collector",
            provider: "opencode",
            model: "opencode-go/deepseek-v4-flash",
            instructions: "独立调研并写 research 产物。",
            expectedOutput: "research findings",
          },
          {
            idSeed: "reviewer",
            name: "Reviewer",
            role: "Source challenge",
            provider: "opencode",
            model: "opencode-go/deepseek-v4-flash",
            instructions: "复核来源质量。",
            expectedOutput: "review result",
          },
        ],
        routePolicy: {
          allowedTargets: ["Researcher", "Reviewer"],
          notes: ["Reviewer 通过后才能收口"],
        },
        workflow: ["dispatch Researcher", "dispatch Reviewer", "final consolidation"],
      },
    };

    const result = await generateTaskDraft(
      {
        message: "帮我增加一个 Researcher 独立搜索任务",
        projectPath: "/tmp/project",
        projectName: "project",
        model: "opencode-go/deepseek-v4-flash",
        currentDraft,
      },
      {
        runOpencode: async (input) => ({
          ok: true,
          command: "opencode run --format json",
          cwd: input.cwd,
          model: input.model,
          stdout: "已增加 Researcher，但没有返回 JSON。",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
        }),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      assistantMessage: "已增加 Researcher B session agent。",
      sessionPlanPatch: {
        workers: [
          { idSeed: "researcher", name: "Researcher" },
          { idSeed: "reviewer", name: "Reviewer" },
          {
            idSeed: "researcher-b",
            name: "Researcher B",
            role: "Independent search",
            provider: "opencode",
            model: "opencode-go/deepseek-v4-flash",
          },
        ],
        routePolicy: {
          allowedTargets: ["Researcher", "Reviewer", "Researcher B"],
        },
      },
    });
  });
});
