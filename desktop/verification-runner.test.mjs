import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runVerification } from "./verification-runner.cjs";

function makeFakeChild({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.killed = true;
  };

  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    child.emit("close", exitCode, null);
  });

  return child;
}

describe("desktop verification runner", () => {
  it("runs a local verification command and writes run-scoped evidence", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "agent-workspace-verification-"));
    const spawned = {};

    try {
      const result = await runVerification(
        {
          cwd,
          runId: "run-plan-watc-active",
          command: "npm test -- src/lib/taskMachine.test.ts",
          timeoutMs: 1000,
        },
        {
          spawn(command, args, options) {
            spawned.command = command;
            spawned.args = args;
            spawned.options = options;
            return makeFakeChild({ stdout: "102 tests passed\n", exitCode: 0 });
          },
        },
      );

      expect(spawned).toMatchObject({
        command: "/bin/sh",
        args: ["-lc", "npm test -- src/lib/taskMachine.test.ts"],
        options: expect.objectContaining({ cwd }),
      });
      expect(result).toMatchObject({
        ok: true,
        command: "npm test -- src/lib/taskMachine.test.ts",
        cwd,
        runId: "run-plan-watc-active",
        status: "passed",
        exitCode: 0,
        artifactPath: ".agent-workspace/runs/run-plan-watc-active/verification.json",
        logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
      });

      const log = readFileSync(path.join(cwd, result.logPath), "utf8");
      const artifact = JSON.parse(readFileSync(path.join(cwd, result.artifactPath), "utf8"));
      expect(log).toContain("$ npm test -- src/lib/taskMachine.test.ts");
      expect(log).toContain("102 tests passed");
      expect(artifact).toMatchObject({
        runId: "run-plan-watc-active",
        command: "npm test -- src/lib/taskMachine.test.ts",
        status: "passed",
        exitCode: 0,
        logPath: ".agent-workspace/runs/run-plan-watc-active/verification.log",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("records failed command stderr without converting it to approval", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "agent-workspace-verification-"));

    try {
      const result = await runVerification(
        {
          cwd,
          runId: "run-pty-active",
          command: "npm run build",
          timeoutMs: 1000,
        },
        {
          spawn() {
            return makeFakeChild({ stderr: "TypeScript failed\n", exitCode: 1 });
          },
        },
      );

      expect(result).toMatchObject({
        ok: false,
        status: "failed",
        exitCode: 1,
        error: "verification command failed with exit code 1",
      });
      expect(readFileSync(path.join(cwd, result.logPath), "utf8")).toContain("TypeScript failed");
      expect(JSON.parse(readFileSync(path.join(cwd, result.artifactPath), "utf8"))).toMatchObject({
        status: "failed",
        stderr: "TypeScript failed\n",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
