import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireAcpHostEpochLeaseFromSupervisorEnvironment,
  assertAcpHostEpochSupervisorEnvironmentConfigured,
  createAcpHostEpochRecoveryAuthority,
  type AcpHostEpochLease,
} from "./acp-host-epoch-lease.js";
import { createAcpPrivateBindingMap } from "./acp-private-binding-map.js";

const roots: string[] = [];
const leases: AcpHostEpochLease[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) {
    try { lease.close(); } catch { /* a test may deliberately replace its epoch */ }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "close");
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("ACP Host epoch lease and supervisor recovery authority", () => {
  it("preflights the supervisor launch envelope without touching a Runtime root", () => {
    const signer = createTestSupervisorSigner();
    expect(() => assertAcpHostEpochSupervisorEnvironmentConfigured({
      AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_preflight_valid",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
    })).not.toThrow();
    expect(() => assertAcpHostEpochSupervisorEnvironmentConfigured({
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
    })).toThrowError("acp_new_host_epoch_invalid");
    expect(() => assertAcpHostEpochSupervisorEnvironmentConfigured({
      AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_preflight_invalid_key",
      AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: "not-a-key",
    })).toThrowError("acp_host_epoch_recovery_public_key_invalid");
  });

  it("accepts a fresh Desktop supervisor epoch without any recovery proof", () => {
    const root = runtimeRoot();
    const signer = createTestSupervisorSigner();
    const lease = acquireAcpHostEpochLeaseFromSupervisorEnvironment({
      runtimeDataDirectory: root,
      environment: {
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_desktop_fresh_process",
        AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
      },
    });
    leases.push(lease);
    expect(lease.recoveryReceipt()).toBeUndefined();
  });

  it("holds one OS-visible epoch lease and cleans the exact inode on normal close", () => {
    const root = runtimeRoot();
    const authority = createAcpHostEpochRecoveryAuthority();
    const first = authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: "host_epoch_exclusive_first",
    });
    leases.push(first);
    expect(() => authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: "host_epoch_exclusive_second",
    })).toThrowError(expect.objectContaining({ code: "acp_host_epoch_lease_held" }));
    first.close();
    leases.pop();
    const second = authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: "host_epoch_exclusive_second",
    });
    leases.push(second);
    expect(JSON.stringify(second)).toBe('{"kind":"acp_host_epoch_lease"}');
  });

  it("reclaims a crashed child epoch only with one exact WeakMap-branded confirmed-dead token", async () => {
    const root = runtimeRoot();
    const deadEpoch = "host_epoch_crashed_child";
    const newEpoch = "host_epoch_recovered_parent";
    const child = spawnLeaseChild(root, deadEpoch);
    children.push(child);
    await waitForReady(child);

    const authority = createAcpHostEpochRecoveryAuthority();
    expect(() => authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: newEpoch,
    })).toThrowError(expect.objectContaining({ code: "acp_host_epoch_lease_held" }));
    child.kill("SIGKILL");
    const closed = once(child, "close").then(() => undefined);
    const token = await authority.supervisorIssuer.issueAfterConfirmedExit({
      runtimeDataDirectory: root,
      deadHostEpoch: deadEpoch,
      newHostEpoch: newEpoch,
      awaitConfirmedExit: () => closed,
    });
    expect(() => authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: newEpoch,
      confirmedDeadToken: { kind: "confirmed_dead_host_epoch" },
    })).toThrowError(expect.objectContaining({ code: "acp_host_epoch_lease_held" }));

    const recovered = authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: newEpoch,
      confirmedDeadToken: token,
    });
    leases.push(recovered);
    expect(recovered.canReclaimHostEpoch(deadEpoch)).toBe(true);
    expect(recovered.recoveryReceipt()).toEqual({
      kind: "acp_host_epoch_reclaimed",
      receiptDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it("uses the confirmed-dead receipt to reclaim only the crashed epoch's durable Binding generation", async () => {
    const root = runtimeRoot();
    const deadEpoch = "host_epoch_binding_crashed_child";
    const newEpoch = "host_epoch_binding_recovered_parent";
    const child = spawnBindingChild(root, deadEpoch);
    children.push(child);
    await waitForReady(child);
    child.kill("SIGKILL");
    const closed = once(child, "close").then(() => undefined);

    const authority = createAcpHostEpochRecoveryAuthority();
    const token = await authority.supervisorIssuer.issueAfterConfirmedExit({
      runtimeDataDirectory: root,
      deadHostEpoch: deadEpoch,
      newHostEpoch: newEpoch,
      awaitConfirmedExit: () => closed,
    });
    const recovered = authority.hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: newEpoch,
      confirmedDeadToken: token,
    });
    leases.push(recovered);
    const map = createAcpPrivateBindingMap({
      runtimeDataDirectory: root,
      authorityNamespace: "task",
      profileRevisionId: "profile_revision_crash_recovery",
      profileResolutionFingerprint: `sha256:${"c".repeat(64)}`,
      hostEpochLease: recovered,
    });
    expect(map.checkout({
      bindingHandle: "binding_handle_crash_recovery",
      generationId: "acp_generation_recovered_parent",
    })).toBe("raw-session-crash-recovery");
    expect(() => map.checkout({
      bindingHandle: "binding_handle_crash_recovery",
      generationId: "acp_generation_competing_parent",
    })).toThrowError(expect.objectContaining({ code: "acp_private_binding_generation_conflict" }));
  });

  it("imports only the Desktop supervisor's signed confirmed-exit proof into the child Host lease", () => {
    const root = runtimeRoot();
    const deadEpoch = "host_epoch_desktop_process_a";
    const newEpoch = "host_epoch_desktop_process_b";
    const first = createAcpHostEpochRecoveryAuthority().hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: deadEpoch,
    });
    leases.push(first);
    const signer = createTestSupervisorSigner();
    const proof = signer.sign({
      runtimeDataDirectory: root,
      deadHostEpoch: deadEpoch,
      newHostEpoch: newEpoch,
    });
    const recovered = acquireAcpHostEpochLeaseFromSupervisorEnvironment({
      runtimeDataDirectory: root,
      environment: {
        AGENT_WORKSPACE_ACP_HOST_EPOCH: newEpoch,
        AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
        AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF: proof,
      },
    });
    leases.push(recovered);
    expect(recovered.canReclaimHostEpoch(deadEpoch)).toBe(true);
    expect(recovered.recoveryReceipt()).toMatchObject({ kind: "acp_host_epoch_reclaimed" });

    expect(() => acquireAcpHostEpochLeaseFromSupervisorEnvironment({
      runtimeDataDirectory: root,
      environment: {
        AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_desktop_process_c",
        AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
        AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF: `${proof.slice(0, -1)}A`,
      },
    })).toThrowError(expect.objectContaining({ code: "acp_host_epoch_recovery_proof_invalid" }));
  });
});

function createTestSupervisorSigner(): Readonly<{
  publicKey: string;
  sign(input: Readonly<{
    runtimeDataDirectory: string;
    deadHostEpoch: string;
    newHostEpoch: string;
  }>): string;
}> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return Object.freeze({
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    sign(input) {
      const payload = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        runtimeRootDigest: createHash("sha256").update(realpathSync(input.runtimeDataDirectory)).digest("hex"),
        deadHostEpoch: input.deadHostEpoch,
        newHostEpoch: input.newHostEpoch,
        nonce: "supervisor_test_nonce_0123456789",
      }), "utf8");
      return Buffer.from(JSON.stringify({
        payload: payload.toString("base64url"),
        signature: sign(null, payload, privateKey).toString("base64url"),
      }), "utf8").toString("base64url");
    },
  });
}

function runtimeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-host-epoch-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function spawnLeaseChild(root: string, hostEpoch: string): ChildProcess {
  const moduleUrl = pathToFileURL(path.join(
    process.cwd(),
    "apps/runtime-host/src/acp-host-epoch-lease.ts",
  )).href;
  const source = `
    import { createAcpHostEpochRecoveryAuthority } from ${JSON.stringify(moduleUrl)};
    createAcpHostEpochRecoveryAuthority().hostLeaseFactory.acquire({
      runtimeDataDirectory: process.argv[1],
      newHostEpoch: process.argv[2],
    });
    process.stdout.write("READY\\n");
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", source, root, hostEpoch,
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

function spawnBindingChild(root: string, hostEpoch: string): ChildProcess {
  const leaseModuleUrl = pathToFileURL(path.join(
    process.cwd(),
    "apps/runtime-host/src/acp-host-epoch-lease.ts",
  )).href;
  const mapModuleUrl = pathToFileURL(path.join(
    process.cwd(),
    "apps/runtime-host/src/acp-private-binding-map.ts",
  )).href;
  const source = `
    import { closeSync, constants, fsyncSync, openSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { createAcpHostEpochRecoveryAuthority } from ${JSON.stringify(leaseModuleUrl)};
    import { createAcpPrivateBindingMap } from ${JSON.stringify(mapModuleUrl)};
    const lease = createAcpHostEpochRecoveryAuthority().hostLeaseFactory.acquire({
      runtimeDataDirectory: process.argv[1],
      newHostEpoch: process.argv[2],
    });
    const map = createAcpPrivateBindingMap({
      runtimeDataDirectory: process.argv[1],
      authorityNamespace: "task",
      profileRevisionId: "profile_revision_crash_recovery",
      profileResolutionFingerprint: "sha256:${"c".repeat(64)}",
      hostEpochLease: lease,
    });
    map.bindNew({
      bindingHandle: "binding_handle_crash_recovery",
      generationId: "acp_generation_crashed_child",
      rawSessionId: "raw-session-crash-recovery",
    });
    const directory = path.join(process.argv[1], "acp-private", "task");
    const lock = path.join(directory, "binding-map.v1.lock");
    const descriptor = openSync(
      lock,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, hostEpoch: process.argv[2] }) + "\\n");
    fsyncSync(descriptor);
    closeSync(descriptor);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    fsyncSync(directoryDescriptor);
    closeSync(directoryDescriptor);
    process.stdout.write("READY\\n");
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", source, root, hostEpoch,
  ], { stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForReady(child: ChildProcess): Promise<void> {
  let output = "";
  child.stdout!.setEncoding("utf8");
  for await (const chunk of child.stdout!) {
    output += chunk;
    if (output.includes("READY\n")) return;
  }
  const stderr = child.stderr ? await streamText(child.stderr) : "";
  throw new Error(`lease child exited before ready: ${stderr}`);
}

async function streamText(stream: NodeJS.ReadableStream): Promise<string> {
  let result = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) result += chunk;
  return result;
}
