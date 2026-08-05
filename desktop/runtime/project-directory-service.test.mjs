import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAgentLoopProjectDirectoryService } = require("./project-directory-service.cjs");

test("project directory service creates exactly one new child of a verified parent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workspace-project-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, "tempreport");
  await fs.mkdir(parent);
  const service = createAgentLoopProjectDirectoryService({ homePath: () => root });

  const created = await service.createChild({ parentPath: "~/tempreport", name: "storage-industry-e2e" });
  assert.deepEqual(created, {
    path: path.join(parent, "storage-industry-e2e"),
    name: "storage-industry-e2e",
    created: true,
  });
  assert.equal((await fs.stat(created.path)).isDirectory(), true);

  await assert.rejects(
    () => service.createChild({ parentPath: parent, name: "../outside" }),
    /直接子目录名/,
  );
  await assert.rejects(
    () => service.createChild({ parentPath: parent, name: "nested/child" }),
    /直接子目录名/,
  );
  await assert.rejects(
    () => service.createChild({ parentPath: parent, name: "storage-industry-e2e" }),
    /已存在/,
  );
  await assert.rejects(
    () => service.createChild({ parentPath: path.join(parent, "missing"), name: "child" }),
    /不存在或无法访问/,
  );
  await assert.rejects(
    () => service.validate({ path: path.join(parent, "not-a-directory") }),
    /不存在或无法访问/,
  );
});
