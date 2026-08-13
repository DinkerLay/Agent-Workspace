import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertAcpPrivateBindingPresenceAuthorityScope,
  claimAcpPrivateBindingDispositionAuthority,
  claimAcpPrivateBindingPresenceAuthority,
  createAcpPrivateBindingMap,
  createAcpPrivateBindingVaultResolver,
} from "./acp-private-binding-map.js";
import {
  createAcpHostEpochRecoveryAuthority,
  type AcpHostEpochLease,
} from "./acp-host-epoch-lease.js";

const profileA = {
  profileRevisionId: "profile_revision_private_a",
  profileResolutionFingerprint: `sha256:${"a".repeat(64)}`,
} as const;
const profileB = {
  profileRevisionId: "profile_revision_private_b",
  profileResolutionFingerprint: `sha256:${"b".repeat(64)}`,
} as const;

const roots: string[] = [];
const leases = new Map<string, AcpHostEpochLease>();
let epochSequence = 0;

afterEach(() => {
  for (const lease of leases.values()) lease.close();
  leases.clear();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function runtimeDataDirectory(): string {
  const root = mkdtempSync(path.join(tmpdir(), "agent-workspace-acp-private-map-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

function hostLease(root: string): AcpHostEpochLease {
  let lease = leases.get(root);
  if (!lease) {
    lease = createAcpHostEpochRecoveryAuthority().hostLeaseFactory.acquire({
      runtimeDataDirectory: root,
      newHostEpoch: `host_epoch_private_test_${++epochSequence}`,
    });
    leases.set(root, lease);
  }
  return lease;
}

function bindingMap(
  root: string,
  profile: typeof profileA | typeof profileB,
  authorityNamespace: "task" | "meta" = "task",
) {
  return createAcpPrivateBindingMap({
    runtimeDataDirectory: root,
    authorityNamespace,
    hostEpochLease: hostLease(root),
    ...profile,
  });
}

describe("Host-private ACP Binding recovery map", () => {
  it("issues read-only exact-scope absent/present authorities across a clean Host epoch", () => {
    const root = runtimeDataDirectory();
    const firstLease = hostLease(root);
    const first = createAcpPrivateBindingVaultResolver({
      runtimeDataDirectory: root,
      authorityNamespace: "task",
      hostEpochLease: firstLease,
    });
    const scope = Object.freeze({
      bindingHandle: "binding_handle_presence_cross_epoch",
      profileRevisionId: profileA.profileRevisionId,
      profileResolutionFingerprint: profileA.profileResolutionFingerprint,
      providerFamily: "opencode" as const,
    });

    const absent = first.observeBindingPresence(scope);
    expect(claimAcpPrivateBindingPresenceAuthority({
      authority: absent,
      resolver: first,
      bindingHandle: scope.bindingHandle,
      profileRevisionId: scope.profileRevisionId,
      providerFamily: scope.providerFamily,
    })).toBe("absent");
    expect(claimAcpPrivateBindingDispositionAuthority({
      authority: absent,
      resolver: first,
      ...scope,
    })).toBe("create");
    expect(JSON.stringify(absent)).toBe('{"kind":"host_private_acp_binding_presence_authority"}');
    expect(JSON.stringify(absent)).not.toContain(scope.profileResolutionFingerprint);

    const firstVault = first(profileA);
    firstVault.bindNew({
      bindingHandle: scope.bindingHandle,
      generationId: "acp_generation_presence_host_a",
      rawSessionId: "raw-session-presence-host-a",
    });
    firstVault.detachBinding({
      bindingHandle: scope.bindingHandle,
      generationId: "acp_generation_presence_host_a",
    });
    const mapFile = path.join(root, "acp-private", "task", "binding-map.v1.json");
    const beforeObservation = readFileSync(mapFile, "utf8");

    firstLease.close();
    leases.delete(root);
    const secondLease = hostLease(root);
    const second = createAcpPrivateBindingVaultResolver({
      runtimeDataDirectory: root,
      authorityNamespace: "task",
      hostEpochLease: secondLease,
    });
    const present = second.observeBindingPresence(scope);
    expect(readFileSync(mapFile, "utf8")).toBe(beforeObservation);
    expect(claimAcpPrivateBindingPresenceAuthority({
      authority: present,
      resolver: second,
      bindingHandle: scope.bindingHandle,
      profileRevisionId: scope.profileRevisionId,
      providerFamily: scope.providerFamily,
    })).toBe("present");
    expect(claimAcpPrivateBindingDispositionAuthority({
      authority: present,
      resolver: second,
      ...scope,
    })).toBe("load");
    const activeScope = Object.freeze({
      ...scope,
      bindingHandle: "binding_handle_presence_active_current_epoch",
    });
    second(profileA).bindNew({
      bindingHandle: activeScope.bindingHandle,
      generationId: "acp_generation_presence_active_current_epoch",
      rawSessionId: "raw-session-presence-active-current-epoch",
    });
    const active = second.observeBindingPresence(activeScope);
    expect(claimAcpPrivateBindingDispositionAuthority({
      authority: active,
      resolver: second,
      ...activeScope,
    })).toBe("resume");
    expect(() => assertAcpPrivateBindingPresenceAuthorityScope({
      authority: present,
      resolver: second,
      ...scope,
      profileResolutionFingerprint: `sha256:${"f".repeat(64)}`,
    })).toThrowError(expect.objectContaining({
      code: "acp_private_binding_presence_authority_scope_mismatch",
    }));
    expect(() => claimAcpPrivateBindingPresenceAuthority({
      authority: { toJSON: () => ({ kind: "host_private_acp_binding_presence_authority" }) },
      resolver: second,
      bindingHandle: scope.bindingHandle,
      profileRevisionId: scope.profileRevisionId,
      providerFamily: scope.providerFamily,
    })).toThrowError(expect.objectContaining({
      code: "acp_private_binding_presence_authority_invalid",
    }));
  });

  it("persists one raw session behind an opaque Binding in a 0600 atomic map", () => {
    const root = runtimeDataDirectory();
    const map = bindingMap(root, profileA);

    map.bindNew({
      bindingHandle: "binding_handle_private_a",
      generationId: "acp_generation_private_a1",
      rawSessionId: "raw-session-private-a",
    });

    const file = path.join(root, "acp-private", "task", "binding-map.v1.json");
    expect(lstatSync(path.join(root, "acp-private")).mode & 0o777).toBe(0o700);
    expect(lstatSync(path.join(root, "acp-private", "task")).mode & 0o777).toBe(0o700);
    expect(lstatSync(file).isFile()).toBe(true);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain("raw-session-private-a");
    expect(JSON.stringify(map)).toBe('{"kind":"host_private_acp_binding_map"}');

    map.detachBinding({
      bindingHandle: "binding_handle_private_a",
      generationId: "acp_generation_private_a1",
    });
    const reopened = bindingMap(root, profileA);
    expect(reopened.checkout({
      bindingHandle: "binding_handle_private_a",
      generationId: "acp_generation_private_a2",
    })).toBe("raw-session-private-a");
  });

  it("rejects cross-Profile checkout and a concurrent process generation", () => {
    const root = runtimeDataDirectory();
    const first = bindingMap(root, profileA);
    first.bindNew({
      bindingHandle: "binding_handle_private_fenced",
      generationId: "acp_generation_private_fenced_1",
      rawSessionId: "raw-session-private-fenced",
    });

    const sameProfile = bindingMap(root, profileA);
    expect(() => sameProfile.checkout({
      bindingHandle: "binding_handle_private_fenced",
      generationId: "acp_generation_private_fenced_2",
    })).toThrowError(expect.objectContaining({
      code: "acp_private_binding_generation_conflict",
    }));

    const otherProfile = bindingMap(root, profileB);
    expect(() => otherProfile.checkout({
      bindingHandle: "binding_handle_private_fenced",
      generationId: "acp_generation_private_fenced_1",
    })).toThrowError(expect.objectContaining({
      code: "acp_private_binding_profile_mismatch",
    }));
  });

  it("rejects duplicate opaque Bindings and duplicate raw sessions globally", () => {
    const root = runtimeDataDirectory();
    const first = bindingMap(root, profileA);
    first.bindNew({
      bindingHandle: "binding_handle_private_first",
      generationId: "acp_generation_private_first",
      rawSessionId: "raw-session-private-shared",
    });

    expect(() => first.bindNew({
      bindingHandle: "binding_handle_private_first",
      generationId: "acp_generation_private_replay",
      rawSessionId: "raw-session-private-other",
    })).toThrowError(expect.objectContaining({
      code: "acp_private_binding_already_exists",
    }));

    const secondProfile = bindingMap(root, profileB);
    expect(() => secondProfile.bindNew({
      bindingHandle: "binding_handle_private_second",
      generationId: "acp_generation_private_second",
      rawSessionId: "raw-session-private-shared",
    })).toThrowError(expect.objectContaining({
      code: "acp_private_raw_session_duplicate",
    }));
  });

  it("deletes only the exact released Binding and removes an empty recovery file", () => {
    const root = runtimeDataDirectory();
    const map = bindingMap(root, profileA);
    map.bindNew({
      bindingHandle: "binding_handle_private_delete",
      generationId: "acp_generation_private_delete",
      rawSessionId: "raw-session-private-delete",
    });

    expect(() => map.delete({
      bindingHandle: "binding_handle_private_delete",
      generationId: "acp_generation_private_wrong",
    })).toThrowError(expect.objectContaining({
      code: "acp_private_binding_generation_conflict",
    }));
    map.delete({
      bindingHandle: "binding_handle_private_delete",
      generationId: "acp_generation_private_delete",
    });

    expect(() => lstatSync(path.join(root, "acp-private", "task", "binding-map.v1.json"))).toThrow();
  });

  it("fails closed on mode drift, symlinks, malformed bytes, and a stale writer lock", () => {
    const root = runtimeDataDirectory();
    const privateDirectory = path.join(root, "acp-private");
    mkdirSync(privateDirectory, { mode: 0o700 });
    const directory = path.join(privateDirectory, "task");
    mkdirSync(directory, { mode: 0o700 });
    const file = path.join(directory, "binding-map.v1.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    expect(() => bindingMap(root, profileA))
      .toThrowError(expect.objectContaining({ code: "acp_private_binding_map_unsafe" }));

    rmSync(file);
    const target = path.join(root, "target.json");
    writeFileSync(target, "{}", { mode: 0o600 });
    symlinkSync(target, file);
    expect(() => bindingMap(root, profileA))
      .toThrowError(expect.objectContaining({ code: "acp_private_binding_map_unsafe" }));

    rmSync(file);
    writeFileSync(file, "not-json", { mode: 0o600 });
    expect(() => bindingMap(root, profileA))
      .toThrowError(expect.objectContaining({ code: "acp_private_binding_map_corrupt" }));

    rmSync(file);
    const lock = path.join(directory, "binding-map.v1.lock");
    writeFileSync(lock, `${JSON.stringify({ schemaVersion: 1, hostEpoch: hostLease(root).hostEpoch })}\n`, { mode: 0o600 });
    expect(() => bindingMap(root, profileA))
      .toThrowError(expect.objectContaining({ code: "acp_private_binding_map_locked" }));
  });

  it("keeps Task and Meta namespaces isolated behind profile/resolution-scoped resolver capabilities", () => {
    const root = runtimeDataDirectory();
    const lease = hostLease(root);
    const task = createAcpPrivateBindingVaultResolver({
      runtimeDataDirectory: root,
      authorityNamespace: "task",
      hostEpochLease: lease,
    });
    const meta = createAcpPrivateBindingVaultResolver({
      runtimeDataDirectory: root,
      authorityNamespace: "meta",
      hostEpochLease: lease,
    });
    const taskVault = task(profileA);
    taskVault.bindNew({
      bindingHandle: "binding_handle_namespace_fenced",
      generationId: "acp_generation_namespace_task",
      rawSessionId: "raw-session-namespace-task",
    });
    expect(task(profileA)).toBe(taskVault);
    expect(() => meta(profileA).checkout({
      bindingHandle: "binding_handle_namespace_fenced",
      generationId: "acp_generation_namespace_meta",
    })).toThrowError(expect.objectContaining({ code: "acp_private_binding_not_found" }));
  });

  it("rejects forged and normally closed Host lease capabilities", () => {
    const root = runtimeDataDirectory();
    const forged = {
      hostEpoch: "host_epoch_forged_capability",
      canonicalRuntimeRoot: root,
      canReclaimHostEpoch: () => true,
      recoveryReceipt: () => undefined,
      close: () => undefined,
      toJSON: () => ({ kind: "acp_host_epoch_lease" as const }),
    } as AcpHostEpochLease;
    expect(() => createAcpPrivateBindingMap({
      runtimeDataDirectory: root,
      authorityNamespace: "task",
      hostEpochLease: forged,
      ...profileA,
    })).toThrowError(expect.objectContaining({ code: "acp_private_binding_host_lease_invalid" }));

    const map = bindingMap(root, profileA);
    hostLease(root).close();
    expect(() => map.bindNew({
      bindingHandle: "binding_handle_closed_lease",
      generationId: "acp_generation_closed_lease",
      rawSessionId: "raw-session-closed-lease",
    })).toThrowError(expect.objectContaining({ code: "acp_host_epoch_lease_capability_invalid" }));
  });
});
