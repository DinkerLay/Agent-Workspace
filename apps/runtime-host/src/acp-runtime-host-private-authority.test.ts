import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claimAcpMetaPrivateRootAuthority,
  claimAcpTaskPrivateRootAuthority,
  createAcpRuntimeHostPrivateAuthority,
} from "./acp-runtime-host-private-authority.js";

describe("ACP Runtime Host private authority composition", () => {
  it("mints the Task private-root authority from the same canonical Runtime root", () => {
    withRuntimeRoot((runtimeDataDirectory) => {
      const authority = createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: freshSupervisorEnvironment("host_epoch_private_root_authority"),
      });
      const taskRoot = claimAcpTaskPrivateRootAuthority({
        authority: authority.taskPrivateRootAuthority,
        identityVaultResolver: authority.taskIdentityVaults,
      });
      const metaRoot = claimAcpMetaPrivateRootAuthority({
        authority: authority.metaPrivateRootAuthority,
        identityVaultResolver: authority.metaIdentityVaults,
      });

      expect(taskRoot).toBe(path.join(realpathSync(runtimeDataDirectory), "acp-task-provider-runtime"));
      expect(lstatSync(taskRoot).isDirectory()).toBe(true);
      expect(lstatSync(taskRoot).isSymbolicLink()).toBe(false);
      expect(lstatSync(taskRoot).mode & 0o777).toBe(0o700);
      expect(metaRoot).toBe(path.join(realpathSync(runtimeDataDirectory), "acp-meta-provider-runtime"));
      expect(metaRoot).not.toBe(taskRoot);
      expect(lstatSync(metaRoot).mode & 0o777).toBe(0o700);
      expect(JSON.stringify(authority.taskPrivateRootAuthority)).toBe(
        '{"kind":"acp_task_private_root_authority"}',
      );
      expect(JSON.stringify(authority.taskPrivateRootAuthority)).not.toContain(runtimeDataDirectory);
      expect(() => claimAcpTaskPrivateRootAuthority({
        authority: { toJSON: () => ({ kind: "acp_task_private_root_authority" }) },
        identityVaultResolver: authority.taskIdentityVaults,
      })).toThrowError("acp_task_private_root_authority_invalid");
      expect(() => claimAcpMetaPrivateRootAuthority({
        authority: authority.metaPrivateRootAuthority,
        identityVaultResolver: authority.taskIdentityVaults,
      })).toThrowError("acp_meta_private_root_authority_invalid");

      authority.close();
      expect(() => claimAcpTaskPrivateRootAuthority({
        authority: authority.taskPrivateRootAuthority,
        identityVaultResolver: authority.taskIdentityVaults,
      })).toThrowError("acp_task_private_root_authority_invalid");
    });
  });

  it("owns one verified Host epoch and isolates Task and Meta durable raw identity vaults", () => {
    withRuntimeRoot((runtimeDataDirectory) => {
      const authority = createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: freshSupervisorEnvironment("host_epoch_private_authority_a"),
      });
      const scope = {
        profileRevisionId: "profile_revision_shared",
        profileResolutionFingerprint: `sha256:${"a".repeat(64)}`,
      } as const;
      const task = authority.taskIdentityVaults(scope);
      const meta = authority.metaIdentityVaults(scope);

      task.bindNew({
        bindingHandle: "binding_handle_task",
        generationId: "generation_task_a",
        rawSessionId: "raw-task-session",
      });
      meta.bindNew({
        bindingHandle: "binding_handle_meta",
        generationId: "generation_meta_a",
        rawSessionId: "raw-meta-session",
      });

      expect(task.checkout({
        bindingHandle: "binding_handle_task",
        generationId: "generation_task_a",
      })).toBe("raw-task-session");
      expect(meta.checkout({
        bindingHandle: "binding_handle_meta",
        generationId: "generation_meta_a",
      })).toBe("raw-meta-session");
      expect(() => meta.checkout({
        bindingHandle: "binding_handle_task",
        generationId: "generation_task_a",
      })).toThrowError("acp_private_binding_not_found");
      expect(authority.recoveryObservation()).toEqual({ state: "fresh" });
      expect(JSON.stringify(authority)).toBe('{"kind":"acp_runtime_host_private_authority"}');
      expect(JSON.stringify(authority)).not.toContain(runtimeDataDirectory);
      expect(JSON.stringify(authority)).not.toContain("host_epoch_");
      expect(JSON.stringify(authority)).not.toContain("raw-task-session");

      authority.close();
      expect(() => task.checkout({
        bindingHandle: "binding_handle_task",
        generationId: "generation_task_a",
      })).toThrowError("acp_host_epoch_lease_capability_invalid");
    });
  });

  it("authorizes an exact retiring intent only under a live supervisor-confirmed recovery epoch", () => {
    withRuntimeRoot((runtimeDataDirectory) => {
      const signer = createTestSupervisorSigner();
      const first = createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: {
          AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_private_authority_dead",
          AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
        },
      });
      const intent = retiringIntent();
      expect(first.authorizeRetiringBindingRecovery(intent)).toBe(false);

      const recovered = createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: {
          AGENT_WORKSPACE_ACP_HOST_EPOCH: "host_epoch_private_authority_recovered",
          AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: signer.publicKey,
          AGENT_WORKSPACE_ACP_HOST_EPOCH_RECOVERY_PROOF: signer.sign({
            runtimeDataDirectory,
            deadHostEpoch: "host_epoch_private_authority_dead",
            newHostEpoch: "host_epoch_private_authority_recovered",
          }),
        },
      });
      expect(recovered.authorizeRetiringBindingRecovery(intent)).toBe(true);
      expect(recovered.authorizeRetiringBindingRecovery(intent)).toBe(false);
      expect(JSON.stringify(recovered)).not.toContain(intent.bindingRetirementIntentId);
      recovered.close();
      expect(() => recovered.authorizeRetiringBindingRecovery({
        ...intent,
        bindingRetirementIntentId: "binding_retirement_after_close",
      })).toThrowError("acp_host_epoch_lease_capability_invalid");
    });
  });

  it("keeps Host lease cleanup failure sticky instead of reporting a later successful close", () => {
    withRuntimeRoot((runtimeDataDirectory) => {
      const authority = createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: freshSupervisorEnvironment("host_epoch_private_authority_b"),
      });
      const leaseFile = path.join(runtimeDataDirectory, ".acp-host-epoch.lease");
      renameSync(leaseFile, `${leaseFile}.displaced`);
      writeFileSync(leaseFile, '{"schemaVersion":1,"hostEpoch":"host_epoch_foreign0000"}\n', { mode: 0o600 });

      expect(() => authority.close()).toThrowError("acp_host_epoch_lease_cleanup_unconfirmed");
      expect(() => authority.close()).toThrowError("acp_host_epoch_lease_cleanup_unconfirmed");
    });
  });

  it("rejects an unsafe Runtime data root before returning any resolver", () => {
    const runtimeDataDirectory = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-private-authority-"));
    try {
      chmodSync(runtimeDataDirectory, 0o755);
      expect(() => createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: freshSupervisorEnvironment("host_epoch_private_authority_c"),
      })).toThrowError("acp_host_runtime_root_invalid");
    } finally {
      rmSync(runtimeDataDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an injected resolver or other unknown option before acquiring the Host lease", () => {
    withRuntimeRoot((runtimeDataDirectory) => {
      expect(() => createAcpRuntimeHostPrivateAuthority({
        runtimeDataDirectory,
        environment: freshSupervisorEnvironment("host_epoch_private_authority_d"),
        taskIdentityVaults: () => { throw new Error("must not be called"); },
      } as never)).toThrowError("acp_runtime_host_private_authority_options_invalid");
    });
  });
});

function freshSupervisorEnvironment(hostEpoch: string): NodeJS.ProcessEnv {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    AGENT_WORKSPACE_ACP_HOST_EPOCH: hostEpoch,
    AGENT_WORKSPACE_ACP_HOST_EPOCH_PUBLIC_KEY: publicKey.export({
      format: "der",
      type: "spki",
    }).toString("base64url"),
  };
}

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
        runtimeRootDigest: createHash("sha256")
          .update(realpathSync(input.runtimeDataDirectory))
          .digest("hex"),
        deadHostEpoch: input.deadHostEpoch,
        newHostEpoch: input.newHostEpoch,
        nonce: "private_authority_recovery_nonce_0123456789",
      }), "utf8");
      return Buffer.from(JSON.stringify({
        payload: payload.toString("base64url"),
        signature: sign(null, payload, privateKey).toString("base64url"),
      }), "utf8").toString("base64url");
    },
  });
}

function retiringIntent() {
  return Object.freeze({
    bindingRetirementIntentId: "binding_retirement_private_authority",
    commandId: "command_private_authority",
    idempotencyKey: "private-authority-recovery",
    taskId: "task_private_authority",
    runId: "run_private_authority",
    logicalSessionId: "logical_session_private_authority",
    bindingId: "binding_private_authority",
    bindingRevision: 1,
    bindingHandle: "binding_handle_private_authority",
    executionProfileId: "profile_private_authority",
    profileRevisionId: "profile_revision_private_authority",
    providerFamily: "opencode" as const,
    sessionControlAuditId: "session_control_private_authority",
    state: "retiring" as const,
    attempts: 1,
    revision: 2,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:01.000Z",
  });
}

function withRuntimeRoot(run: (runtimeDataDirectory: string) => void): void {
  const runtimeDataDirectory = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-private-authority-"));
  try {
    chmodSync(runtimeDataDirectory, 0o700);
    run(runtimeDataDirectory);
  } finally {
    rmSync(runtimeDataDirectory, { recursive: true, force: true });
  }
}
