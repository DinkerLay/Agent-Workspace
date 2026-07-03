import { describe, expect, it } from "vitest";
import { ensureNodePtySpawnHelperExecutable, resolveNodePtySpawnHelperPath } from "./node-pty-runtime.cjs";

describe("node-pty runtime helpers", () => {
  it("resolves the packaged spawn-helper for the current platform and arch", () => {
    expect(
      resolveNodePtySpawnHelperPath({
        packageJsonPath: "/repo/node_modules/node-pty/package.json",
        platform: "darwin",
        arch: "arm64",
      }),
    ).toBe("/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
  });

  it("marks spawn-helper executable when the package lost its executable bit", () => {
    const chmodCalls = [];

    const result = ensureNodePtySpawnHelperExecutable({
      helperPath: "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      fs: {
        statSync: () => ({ mode: 0o644 }),
        chmodSync: (helperPath, mode) => chmodCalls.push({ helperPath, mode }),
      },
    });

    expect(result).toEqual({
      helperPath: "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      changed: true,
    });
    expect(chmodCalls).toEqual([
      {
        helperPath: "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        mode: 0o755,
      },
    ]);
  });

  it("does not chmod spawn-helper when it is already executable", () => {
    const chmodCalls = [];

    const result = ensureNodePtySpawnHelperExecutable({
      helperPath: "/repo/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
      fs: {
        statSync: () => ({ mode: 0o755 }),
        chmodSync: (helperPath, mode) => chmodCalls.push({ helperPath, mode }),
      },
    });

    expect(result.changed).toBe(false);
    expect(chmodCalls).toEqual([]);
  });
});
