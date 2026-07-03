import { describe, expect, it } from "vitest";
import { buildConductorSystemPrompt } from "./conductorPrompt";

describe("Conductor system prompt", () => {
  it("describes Conductor as task owner and workers as provider-native sessions", () => {
    const prompt = buildConductorSystemPrompt({
      projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      taskId: "task-1",
      taskTitle: "Research Claude Dynamic Workflow",
      taskGoal: "Write research and spec/plan clues.",
      workerTargets: ["Researcher"],
      workerSessions: [{ id: "task-1-researcher", name: "Researcher", role: "Evidence collector" }],
    });

    expect(prompt).toContain("You are the task owner Conductor");
    expect(prompt).toContain("Conductor manages the task mainline, not worker execution details");
    expect(prompt).toContain("Do not personally create, rewrite, or edit worker-owned deliverables");
    expect(prompt).toContain("route that fix as a new call_session assignment");
    expect(prompt).toContain("do not apply the fix yourself");
    expect(prompt).toContain("Worker sessions are provider-native terminals");
    expect(prompt).toContain("Use call_session to assign session-level work");
    expect(prompt).toContain("includes one 6-character dispatchId");
    expect(prompt).toContain("match the result to the relevant dispatchId");
    expect(prompt).not.toContain("dispatchKey");
    expect(prompt).toContain("After a successful call_session result, end this Conductor turn");
    expect(prompt).toContain("Use read_task_state at the start of a Runtime-triggered turn");
    expect(prompt).toContain("Use read_session to inspect Shell-owned provider-extracted session results");
    expect(prompt).toContain("Allowed worker target roles:");
    expect(prompt).not.toContain("finish_task_claim");
    expect(prompt).not.toContain("Use ask_user");
    expect(prompt).not.toContain("Use continue_session");
    expect(prompt).not.toContain("Allowed route policy");
    expect(prompt).not.toContain("Workspace Session Message");
    expect(prompt).not.toContain("emit exactly one structured message block");
  });

  it("includes the confirmed task session plan as orchestration truth", () => {
    const prompt = buildConductorSystemPrompt({
      projectPath: "/Users/dinker/CODES/TEMP_project/Agent_Test",
      taskId: "task-1",
      taskTitle: "Research Claude Dynamic Workflow",
      taskGoal: "Write research and spec/plan clues.",
      workerTargets: ["Researcher", "Reviewer"],
      workerSessions: [
        { id: "task-1-researcher", name: "Researcher", role: "Evidence collector" },
        { id: "task-1-reviewer", name: "Reviewer", role: "Source challenge" },
      ],
      taskSessionPlan: {
        templateId: "research",
        conductor: {
          idSeed: "conductor",
          name: "Conductor",
          role: "Research coordinator",
          instructions: "任务负责人，不替代 worker 判断 review 修复是否完成。",
        },
        workers: [
          {
            idSeed: "researcher",
            name: "Researcher",
            role: "Evidence collector",
            instructions: "写 research 输出。",
            expectedOutput: "research report",
          },
          {
            idSeed: "reviewer",
            name: "Reviewer",
            role: "Source challenge",
            instructions: "复核 research 输出。",
            expectedOutput: "pass or needs changes",
          },
        ],
        routePolicy: {
          allowedTargets: ["Researcher", "Reviewer"],
          notes: [
            "Reviewer 要求修改时，把完整 Review 文本派回 Researcher。",
            "Researcher 修复后必须再次派 Reviewer 复核。",
          ],
        },
        workflow: ["dispatch Researcher", "dispatch Reviewer", "dispatch Reviewer again after fixes"],
        deliverables: ["docs/research/report.md"],
      },
    });

    expect(prompt).toContain("Confirmed Task Session Plan:");
    expect(prompt).toContain("This plan is the business orchestration source of truth");
    expect(prompt).toContain("Researcher 修复后必须再次派 Reviewer 复核");
    expect(prompt).toContain("dispatch Reviewer again after fixes");
    expect(prompt).toContain("docs/research/report.md");
  });
});
