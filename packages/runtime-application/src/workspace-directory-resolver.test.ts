import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceAuthorizationRecord } from "@agent-workspace/runtime-contracts";
import {
  resolveAuthorizedWorkspaceV3,
  type WorkspaceDirectoryResolver,
} from "./workspace-directory-resolver.js";

const digest = (value: unknown) => `sha256:${createHash("sha256")
  .update(JSON.stringify(value))
  .digest("hex")}`;

const AUTHORIZATION: WorkspaceAuthorizationRecord = Object.freeze({
  workspaceId: "workspace_acp_v3",
  canonicalDirectory: "/private/host/workspace",
  displayName: "Workspace",
  authorizedAt: "2026-08-12T00:00:00.000Z",
});

describe("resolveAuthorizedWorkspaceV3", () => {
  it("revalidates the Host directory and returns only an opaque stable grant", async () => {
    const resolver: WorkspaceDirectoryResolver = {
      digestGrant: digest,
      canonicalizeDirectory: async () => ({
        canonicalDirectory: AUTHORIZATION.canonicalDirectory,
        defaultDisplayName: "ignored",
      }),
    };

    const first = await resolveAuthorizedWorkspaceV3(resolver, AUTHORIZATION);
    const replay = await resolveAuthorizedWorkspaceV3(resolver, {
      ...AUTHORIZATION,
      displayName: "Renamed display label",
    });

    expect(first).toEqual(replay);
    expect(first.workspaceId).toBe(AUTHORIZATION.workspaceId);
    expect(first.grantDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(first)).not.toContain(AUTHORIZATION.canonicalDirectory);
    expect(Object.keys(first).sort()).toEqual(["grantDigest", "workspaceId"]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("rejects a changed canonical target before returning a grant", async () => {
    const resolver: WorkspaceDirectoryResolver = {
      digestGrant: digest,
      canonicalizeDirectory: async () => ({
        canonicalDirectory: "/private/host/retargeted",
        defaultDisplayName: "retargeted",
      }),
    };

    await expect(resolveAuthorizedWorkspaceV3(resolver, AUTHORIZATION))
      .rejects.toThrow("workspace_authorization_stale");
  });

  it("binds a new authorization epoch to a different grant digest", async () => {
    const resolver: WorkspaceDirectoryResolver = {
      digestGrant: digest,
      canonicalizeDirectory: async () => ({
        canonicalDirectory: AUTHORIZATION.canonicalDirectory,
        defaultDisplayName: "Workspace",
      }),
    };

    const first = await resolveAuthorizedWorkspaceV3(resolver, AUTHORIZATION);
    const renewed = await resolveAuthorizedWorkspaceV3(resolver, {
      ...AUTHORIZATION,
      authorizedAt: "2026-08-12T01:00:00.000Z",
    });

    expect(renewed.grantDigest).not.toBe(first.grantDigest);
  });
});
