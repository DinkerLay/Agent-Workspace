import { describe, expect, it } from "vitest";

async function readWorkspaceFile(path: string) {
  const fsModule = "node:fs";
  const { readFileSync } = (await import(fsModule)) as {
    readFileSync: (path: URL, encoding: "utf8") => string;
  };

  return readFileSync(new URL("../../" + path, import.meta.url), "utf8");
}

describe("durable product intent docs", () => {
  it("keeps Agent Loop distinct from Workflow", async () => {
    const [charter, model] = await Promise.all([
      readWorkspaceFile("docs/superworks/spec/agent-workspace-architecture-charter.md"),
      readWorkspaceFile("docs/superworks/spec/task-template-runtime-model.md"),
    ]);

    expect(charter).toContain("They must not be conflated.");
    expect(model).toContain("Agent Loop is a session-management orchestration policy.");
    expect(model).toContain("graph-execution policy. They are both reusable template families");
    expect(model).toContain("Agent Loop Template cannot be serialized as a Workflow graph");
  });

  it("records Template Builder Draft, saved Blueprint, confirmed Task Architecture, and fresh Task Run boundaries", async () => {
    const model = await readWorkspaceFile("docs/superworks/spec/task-template-runtime-model.md");

    expect(model).toContain("Template Draft");
    expect(model).toContain("Task Architecture");
    expect(model).toContain("Task Run");
    expect(model).toContain("Template Blueprint");
    expect(model).toContain("Template creation belongs to **Template Builder**, not the Task dialog.");
    expect(model).toMatch(/A generated\s+or manual Draft is not task execution/);
    expect(model).toContain("A separate Start action begins runtime execution.");
  });

  it("defines the four product surfaces and semantic task timeline", async () => {
    const spec = await readWorkspaceFile("docs/superworks/spec/product-interaction-map.md");

    expect(spec).toContain("| Task Assembly |");
    expect(spec).toContain("| Templates |");
    expect(spec).toContain("| Tasks |");
    expect(spec).toContain("| Workbench |");
    expect(spec).toContain("semantic event projection");
    expect(spec).toContain("Raw terminals do not appear as the primary task conversation.");
  });

  it("keeps Workbench task-run scoped and Workflow aggregates terminal-free", async () => {
    const [spec, model] = await Promise.all([
      readWorkspaceFile("docs/superworks/spec/product-interaction-map.md"),
      readWorkspaceFile("docs/superworks/spec/task-template-runtime-model.md"),
    ]);

    expect(spec).toContain("Task Run tabs are temporary open context");
    expect(spec).toContain("A Workflow aggregate has no PTY.");
    expect(model).toContain("A Workflow aggregate never masquerades as a PTY-owning Session.");
  });

  it("indexes the active specs and preserves superseded material as archive", async () => {
    const readme = await readWorkspaceFile("docs/superworks/spec/spec_readme.md");

    expect(readme).toContain("task-template-runtime-model.md");
    expect(readme).toContain("2026-06-24-product-interaction-map-board-first.md");
    expect(readme).toContain("2026-07-24-pre-task-architecture");
  });
});
