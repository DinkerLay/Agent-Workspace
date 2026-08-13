import { lstat, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAcpBindingPrivateStorageRegistry } from "./acp-binding-private-storage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ACP Binding-stable private storage registry", () => {
  it("keeps exact 0700 process/state paths across generations and separates Bindings", async () => {
    const created = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-acp-private-storage-"));
    const root = await realpath(created);
    roots.push(root);
    const parent = path.join(root, "private");
    await mkdir(parent, { mode: 0o700 });
    const registry = createAcpBindingPrivateStorageRegistry({ parentDirectory: parent });

    const generation1 = await registry.acquire("binding_handle_a");
    const bindingB = await registry.acquire("binding_handle_b");
    expect(generation1.processWorkingDirectory).not.toBe(bindingB.processWorkingDirectory);
    expect(generation1.providerDataDirectory).not.toBe(bindingB.providerDataDirectory);
    expect((await stat(generation1.processWorkingDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(generation1.providerDataDirectory)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(generation1.providerDataDirectory, "provider.db"), "private-session-state");
    await writeFile(path.join(generation1.processWorkingDirectory, "provider-private.tmp"), "private");
    await generation1.prepareForRestart();

    const generation2 = await registry.acquire("binding_handle_a");
    expect(generation2.processWorkingDirectory).toBe(generation1.processWorkingDirectory);
    expect(generation2.providerDataDirectory).toBe(generation1.providerDataDirectory);
    expect(await stat(path.join(generation2.providerDataDirectory, "provider.db"))).toBeDefined();
    expect(await generation2.assertProcessWorkingDirectoryEmpty()).toBe(true);
    expect(JSON.stringify(registry.safeObservation())).not.toContain(generation1.processWorkingDirectory);
    expect(JSON.stringify(registry.safeObservation())).not.toContain("binding_handle_a");

    await generation2.releaseBinding();
    await expect(stat(generation1.processWorkingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(generation1.providerDataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await bindingB.releaseBinding();
  });

  it("deletes a poisoned process path but never reports cleanup success after preparation fails", async () => {
    const created = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-acp-private-poison-"));
    const root = await realpath(created);
    roots.push(root);
    const parent = path.join(root, "private");
    const outside = path.join(root, "must-not-delete");
    await mkdir(parent, { mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    const registry = createAcpBindingPrivateStorageRegistry({ parentDirectory: parent });
    const lease = await registry.acquire("binding_handle_poisoned");

    await rm(lease.processWorkingDirectory, { recursive: true, force: true });
    await symlink(outside, lease.processWorkingDirectory);
    await expect(lease.prepareForRestart()).rejects.toMatchObject({
      code: "acp_binding_private_storage_invalid",
    });

    await expect(lease.releaseBinding()).rejects.toMatchObject({
      code: "acp_binding_private_storage_cleanup_unconfirmed",
    });
    await expect(lstat(lease.processWorkingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(outside)).isDirectory()).toBe(true);
  });
});
