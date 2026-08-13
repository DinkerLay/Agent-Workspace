import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  hashDefinition,
  HOST_OBSERVED_EVIDENCE_MARKER,
  parseTemplatePackageYaml,
  providerFactDedupKey,
  providerFactFingerprint,
  serializeTemplatePackageYaml,
  validateTemplateDefinition,
  validateTemplatePackage,
} from "../src";
import type { ExecutionProfileReadinessReadModel, RuntimeCommand } from "../src";
import { providerFactFixture, templatePackageFixture } from "../../test-kit/src";

describe("runtime contracts", () => {
  it("canonicalizes JSON before calculating a portable definition hash", () => {
    const left = { b: [2, { z: true, a: null }], a: "value" };
    const right = { a: "value", b: [2, { a: null, z: true }] };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(hashDefinition(left)).toBe(hashDefinition(right));
  });

  it("exports and imports a portable YAML template package without runtime secrets", () => {
    const source = templatePackageFixture();
    const yaml = serializeTemplatePackageYaml(source);
    expect(yaml).toContain("schemaVersion: 2");
    expect(yaml).toContain("agentCards:");
    expect(parseTemplatePackageYaml(yaml)).toEqual(source);
    expect(() => validateTemplatePackage({ ...source, schemaVersion: 1 })).toThrow(/unsupported template schema version/);
    expect(() => validateTemplateDefinition({
      ...source.definition,
      agentCards: source.definition.agentCards.map((card) => ({ ...card, dispatchProfile: undefined })),
    })).toThrow(/dispatchProfile is required/);
    expect(() => validateTemplatePackage({
      ...source,
      definition: { ...source.definition, apiKey: "never-export" },
    })).toThrow(/portable template content/);
  });

  it("rejects a published profile that cannot support managed Task lifecycle", () => {
    const source = templatePackageFixture().definition;
    expect(() => validateTemplateDefinition({
      ...source,
      executionProfiles: source.executionProfiles.map((profile) => ({
        ...profile,
        capabilityPolicy: {
          ...profile.capabilityPolicy,
          requiredCapabilities: profile.capabilityPolicy.requiredCapabilities.filter((capability) => capability !== "resume_binding"),
        },
      })),
    })).toThrow(/managed capability: resume_binding/);
  });

  it("keeps v2 provider evidence fields as non-authoritative compatibility metadata", () => {
    const source = templatePackageFixture().definition;
    const definition = validateTemplateDefinition({
      ...source,
      executionProfiles: source.executionProfiles.map((profile) => ({
        ...profile,
        providerVersion: HOST_OBSERVED_EVIDENCE_MARKER,
        protocolFingerprint: HOST_OBSERVED_EVIDENCE_MARKER,
      })),
    });

    expect(definition.executionProfiles[0]).toMatchObject({
      providerVersion: "host-observed",
      protocolFingerprint: "host-observed",
    });

    const readiness: ExecutionProfileReadinessReadModel = {
      templateVersionId: "template_version_observed",
      executionProfileId: "profile_observed",
      status: "available",
      unavailableReasons: [],
      missingCapabilities: [],
      observedProviderVersion: "0.147.0",
      observedProtocolFingerprint: "sha256:live-protocol",
    };
    expect(readiness).toMatchObject({
      observedProviderVersion: "0.147.0",
      observedProtocolFingerprint: "sha256:live-protocol",
    });
  });

  it("uses provider event, source cursor, then watermark fingerprints for Fact dedup", () => {
    expect(providerFactDedupKey(providerFactFixture())).toContain("event:event-001");
    expect(providerFactDedupKey(providerFactFixture({ deduplication: { sourceInstanceId: "host-a", cursor: "42" } })))
      .toContain("cursor:host-a:42");
    expect(providerFactDedupKey(providerFactFixture({ deduplication: { reconciliationWatermark: "history-17" } })))
      .toContain("watermark:history-17:fnv1a64:");
    expect(() => providerFactDedupKey(providerFactFixture({ deduplication: {} }))).toThrow("provider_fact_deduplication_evidence_required");
  });

  it("replays one native Provider event across Binding recovery but rejects semantic changes", () => {
    const fact = providerFactFixture();
    expect(providerFactFingerprint({
      ...fact,
      bindingRevision: fact.bindingRevision + 1,
      deduplication: { ...fact.deduplication, sourceInstanceId: "reopened-host" },
    })).toBe(providerFactFingerprint(fact));
    expect(providerFactFingerprint({ ...fact, payload: { changed: true } }))
      .not.toBe(providerFactFingerprint(fact));
    expect(providerFactFingerprint({
      ...fact,
      correlation: { ...fact.correlation, inputSubmissionId: "input_other" },
    })).not.toBe(providerFactFingerprint(fact));
  });

  it("exposes Task creation as an authorized workspace ID, never a raw cwd", () => {
    type CreateTask = Extract<RuntimeCommand, { readonly type: "task.create" }>;
    const command: CreateTask = {
      type: "task.create",
      commandId: "command_workspace_contract",
      issuedAt: "2026-08-06T00:00:00.000Z",
      ownerId: "user_workspace_contract",
      workspaceId: "workspace_workspace_contract",
      taskSetupDraftId: "task_setup_draft_workspace_contract",
      expectedTaskSetupRevision: 1,
    };
    expect(command).toEqual(expect.objectContaining({ workspaceId: "workspace_workspace_contract" }));
    expect(command).not.toHaveProperty("taskId");
    expect(JSON.stringify(command)).not.toMatch(/cwd|canonicalDirectory|workspace"\s*:/);

    if (false) {
      const rejectedLegacyShape: CreateTask = {
        ...command,
        // @ts-expect-error `task.create` has no raw workspace/cwd escape hatch.
        workspace: { workspaceId: "workspace_workspace_contract", cwd: "/forbidden" },
      };
      void rejectedLegacyShape;
      const rejectedRendererIdentity: CreateTask = {
        ...command,
        // @ts-expect-error Runtime, not Renderer, allocates the Task identity.
        taskId: "task_renderer_forbidden",
      };
      void rejectedRendererIdentity;
    }
  });

  it("makes Meta send a revision-fenced idempotent intent and lets Runtime allocate message identity", () => {
    type SendMetaMessage = Extract<RuntimeCommand, { readonly type: "meta.send_message" }>;
    const command: SendMetaMessage = {
      type: "meta.send_message",
      commandId: "command_meta_contract",
      issuedAt: "2026-08-09T00:00:00.000Z",
      ownerId: "user_meta_contract",
      metaSessionId: "meta_session_contract",
      expectedSessionRevision: 3,
      expectedTargetRevision: 7,
      idempotencyKey: "meta-contract-turn-1",
      content: "Change the analyst model.",
    };

    expect(command).toMatchObject({
      expectedSessionRevision: 3,
      expectedTargetRevision: 7,
      idempotencyKey: "meta-contract-turn-1",
    });
    expect(JSON.stringify(command)).not.toMatch(/metaMessageId|taskId|runId|bindingId|workspace|cwd/);

    if (false) {
      const rejectedCallerAllocatedMessage: SendMetaMessage = {
        ...command,
        // @ts-expect-error Runtime, not Renderer, allocates the durable Meta message ID.
        metaMessageId: "meta_message_forbidden",
      };
      void rejectedCallerAllocatedMessage;
    }
  });

});
