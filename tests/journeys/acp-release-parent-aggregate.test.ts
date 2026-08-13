import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAcpReleaseParentSubprocessWithTimingForTest } from "./acp-release-parent-aggregate.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACP release parent aggregate", () => {
  it("never treats a timeout-triggered graceful exit as a successful gate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "acp-release-parent-timeout-"));
    roots.push(root);
    const executable = path.join(root, "graceful-on-term.sh");
    await writeFile(executable, [
      "#!/bin/sh",
      "trap 'exit 0' TERM",
      "while true; do sleep 1; done",
      "",
    ].join("\n"), { mode: 0o700 });
    await chmod(executable, 0o700);

    await expect(runAcpReleaseParentSubprocessWithTimingForTest({
      executable,
      args: [],
      environment: Object.freeze({ PATH: process.env.PATH }),
    }, {
      timeoutMs: 25,
      terminationGraceMs: 50,
    })).resolves.toBe(1);
  });

  it("rejects invalid test timing before spawning a process", () => {
    expect(() => runAcpReleaseParentSubprocessWithTimingForTest({
      executable: "/not-observed",
      args: [],
      environment: Object.freeze({}),
    }, {
      timeoutMs: 0,
      terminationGraceMs: 1,
    })).toThrow("acp_release_parent_subprocess_timing_invalid");
  });
});
