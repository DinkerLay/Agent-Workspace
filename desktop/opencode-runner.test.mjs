import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { buildOpencodeRunArgs, listOpencodeAgents, parseOpencodeAgentList, runOpencode } from "./opencode-runner.cjs";

describe("desktop opencode runner", () => {
  it("builds an explicit opencode run model argument when a model is selected", () => {
    expect(buildOpencodeRunArgs("Health check", { model: "opencode-go/deepseek-v4-flash" })).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "opencode-go/deepseek-v4-flash",
      "Health check",
    ]);
  });

  it("parses local opencode agent list output", () => {
    expect(
      parseOpencodeAgentList(`build (primary)\n  [\n]\nexplore (subagent)\ngeneral (subagent)\n`),
    ).toEqual([
      { name: "build", kind: "primary" },
      { name: "explore", kind: "subagent" },
      { name: "general", kind: "subagent" },
    ]);
  });

  it("lists local opencode agents through the installed binary", () => {
    const result = listOpencodeAgents({
      resolveOpencodePath: () => "/opt/homebrew/bin/opencode",
      execFileSync: () => `plan (primary)\nbuild (primary)\n`,
    });

    expect(result).toMatchObject({
      ok: true,
      agents: [
        { name: "plan", kind: "primary" },
        { name: "build", kind: "primary" },
      ],
    });
  });

  it("preserves stderr evidence when a model run times out", async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      child.killed = true;
    };

    const resultPromise = runOpencode(
      {
        cwd: "/tmp/project",
        message: "Health check",
        model: "vllm-glm51/glm51",
        timeoutMs: 5,
      },
      {
        existsSync: () => true,
        resolveOpencodePath: () => "/opt/homebrew/bin/opencode",
        spawn(command, args, options) {
          child.command = command;
          child.args = args;
          child.options = options;
          queueMicrotask(() => {
            child.stderr.emit("data", Buffer.from("Too Many Requests\n"));
          });
          return child;
        },
      },
    );

    const result = await resultPromise;

    expect(child.command).toBe("/opt/homebrew/bin/opencode");
    expect(child.args).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "vllm-glm51/glm51",
      "Health check",
    ]);
    expect(child.killed).toBe(true);
    expect(result).toMatchObject({
      ok: false,
      command: "/opt/homebrew/bin/opencode run --format json --model vllm-glm51/glm51",
      cwd: "/tmp/project",
      exitCode: null,
      error: "timeout",
      model: "vllm-glm51/glm51",
    });
    expect(result.stderr).toContain("Too Many Requests");
    expect(result.stderr).toContain("opencode run timed out after 5ms");
  });
});
