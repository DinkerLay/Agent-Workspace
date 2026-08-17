import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories = [];

test.after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test("start synchronizes the frozen pnpm dependency graph before launching the desktop", async () => {
  const result = await runStartWithManagers(["pnpm"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, [
    "install --frozen-lockfile",
    "run desktop:dev",
  ]);
});

test("start uses npm ci only when pnpm is unavailable", async () => {
  const result = await runStartWithManagers(["npm"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.commands, [
    "ci",
    "run desktop:dev",
  ]);
});

async function runStartWithManagers(managers) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-workspace-start-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const log = path.join(root, "commands.log");
  await mkdir(bin);
  await writeFile(log, "");
  await Promise.all(managers.map(async (manager) => {
    const executable = path.join(bin, manager);
    await writeFile(executable, [
      "#!/usr/bin/env sh",
      `printf '%s\\n' \"$*\" >> '${log}'`,
      "",
    ].join("\n"));
    await chmod(executable, 0o755);
  }));

  const result = spawnSync("bash", ["start.sh"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
    },
  });
  const commands = (await readFile(log, "utf8"))
    .split("\n")
    .filter(Boolean);
  return { ...result, commands };
}
