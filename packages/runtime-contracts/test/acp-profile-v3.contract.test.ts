import { describe, expect, it } from "vitest";
import {
  CURRENT_TEMPLATE_PACKAGE_SCHEMA_VERSION,
  TEMPLATE_PACKAGE_SCHEMA_VERSION_V3,
  parseTemplatePackageYamlV3,
  serializeTemplatePackageYamlV3,
  validateTemplatePackage,
  validateTemplatePackageV3,
  type TemplatePackageV3,
} from "../src";
import { templatePackageFixture } from "../../test-kit/src";

describe("ACP Profile Template package v3 contract", () => {
  it("round-trips only portable ACP requirements and rejects machine/provider-native fields", () => {
    const source = packageV3();
    const yaml = serializeTemplatePackageYamlV3(source);

    expect(CURRENT_TEMPLATE_PACKAGE_SCHEMA_VERSION).toBe(3);
    expect(TEMPLATE_PACKAGE_SCHEMA_VERSION_V3).toBe(3);
    expect(yaml).toContain("schemaVersion: 3");
    expect(parseTemplatePackageYamlV3(yaml)).toEqual(source);
    expect(JSON.stringify(source)).not.toMatch(/providerVersion|protocolFingerprint|launcher|credential|cwd|nativeSession|requestId/);

    expect(() => validateTemplatePackageV3({
      ...source,
      definition: {
        ...source.definition,
        executionProfiles: source.definition.executionProfiles.map((profile) => ({
          ...profile,
          providerVersion: "forbidden-pin",
        })),
      },
    })).toThrow(/not supported|portable template content/);

    expect(() => validateTemplatePackageV3({
      ...source,
      definition: {
        ...source.definition,
        executionProfiles: source.definition.executionProfiles.map((profile) => ({
          ...profile,
          configIntent: { cwd: "/private/workspace" },
        })),
      },
    })).toThrow(/not portable template content/);

    expect(() => validateTemplatePackageV3({
      ...source,
      definition: {
        ...source.definition,
        executionProfiles: source.definition.executionProfiles.map((profile) => ({
          ...profile,
          configIntent: { workspaceRoot: "/private/workspace", requestId: "raw-request" },
        })),
      },
    })).toThrow(/Host-private resolution content/);
  });

  it("keeps published v2 bytes readable without silently upgrading them", () => {
    const publishedV2 = templatePackageFixture();
    const validatedV2 = validateTemplatePackage(publishedV2);

    expect(validatedV2).toEqual(publishedV2);
    expect(validatedV2.schemaVersion).toBe(2);
    expect(() => validateTemplatePackageV3(publishedV2)).toThrow(/schema version/);
  });

  it("accepts ACP extension names but rejects paths and version-pinned identifiers", () => {
    const source = packageV3();
    expect(validateTemplatePackageV3({
      ...source,
      definition: {
        ...source.definition,
        executionProfiles: source.definition.executionProfiles.map((profile, index) => ({
          ...profile,
          requiredExtensions: index === 0
            ? ["session/load", "agent-workspace.dev/structured-final"]
            : [],
        })),
      },
    }).definition.executionProfiles[0]?.requiredExtensions).toEqual([
      "session/load",
      "agent-workspace.dev/structured-final",
    ]);

    for (const extension of [
      "/private/acp-extension",
      "./relative-extension",
      "../parent-extension",
      "C:\\provider\\extension",
      "vendor/feature-v1",
      "vendor/feature-1.2.3",
      "vendor/feature@1.2.3",
      "vendor/feature#sha256-deadbeef",
    ]) {
      expect(() => validateTemplatePackageV3({
        ...source,
        definition: {
          ...source.definition,
          executionProfiles: source.definition.executionProfiles.map((profile, index) => ({
            ...profile,
            requiredExtensions: index === 0 ? [extension] : [],
          })),
        },
      }), extension).toThrow(/not a valid|requiredExtensions.*invalid|version pin|path/i);
    }
  });

  it("recursively rejects Host-private ACP wire keys from config intent", () => {
    const source = packageV3();
    for (const privateWireKey of [
      "sessionId",
      "rawSessionId",
      "providerSessionId",
      "nativeSessionId",
      "nativeBindingRef",
      "request",
      "option",
      "tool",
      "jsonrpc",
      "rawMessage",
    ]) {
      expect(() => validateTemplatePackageV3({
        ...source,
        definition: {
          ...source.definition,
          executionProfiles: source.definition.executionProfiles.map((profile, index) => ({
            ...profile,
            configIntent: index === 0
              ? { behavior: { nested: [{ [privateWireKey]: "host-private-wire-value" }] } }
              : profile.configIntent,
          })),
        },
      }), privateWireKey).toThrow(/Host-private|private wire|portable template content/i);
    }
  });

  it("accepts portable namespaced model and tool identifiers but rejects path-like or controlled values", () => {
    const source = packageV3();
    const portable = validateTemplatePackageV3({
      ...source,
      definition: {
        ...source.definition,
        executionProfiles: source.definition.executionProfiles.map((profile, index) => index === 0
          ? {
              ...profile,
              model: "openai/gpt-5.4-codex",
              capabilityPolicy: {
                ...profile.capabilityPolicy,
                allowedTools: ["invoke_agent", "mcp/github.search_code"],
              },
            }
          : profile),
      },
    });
    expect(portable.definition.executionProfiles[0]?.model).toBe("openai/gpt-5.4-codex");
    expect(portable.definition.executionProfiles[0]?.capabilityPolicy.allowedTools).toEqual([
      "invoke_agent",
      "mcp/github.search_code",
    ]);

    const claudeContextModel = validateTemplatePackageV3({
      ...source,
      definition: {
        ...source.definition,
        executionProfiles: source.definition.executionProfiles.map((profile, index) => index === 0
          ? { ...profile, model: "claude-opus-5[1M]" }
          : profile),
      },
    });
    expect(claudeContextModel.definition.executionProfiles[0]?.model).toBe("claude-opus-5[1M]");

    for (const identifier of [
      "/opt/models/model",
      "file:///opt/models/model",
      "./models/model",
      "../models/model",
      "~/models/model",
      "C:\\models\\model",
      "models/local/model.gguf",
      "openai/gpt\n5",
    ]) {
      expect(() => validateTemplatePackageV3({
        ...source,
        definition: {
          ...source.definition,
          executionProfiles: source.definition.executionProfiles.map((profile, index) => index === 0
            ? { ...profile, model: identifier }
            : profile),
        },
      }), `model: ${JSON.stringify(identifier)}`).toThrow(/model.*(?:identifier|path|control)|portable identifier/i);

      expect(() => validateTemplatePackageV3({
        ...source,
        definition: {
          ...source.definition,
          executionProfiles: source.definition.executionProfiles.map((profile, index) => index === 0
            ? {
                ...profile,
                capabilityPolicy: { ...profile.capabilityPolicy, allowedTools: [identifier] },
              }
            : profile),
        },
      }), `tool: ${JSON.stringify(identifier)}`).toThrow(/allowedTools.*(?:identifier|path|control)|portable identifier/i);
    }
  });
});

function packageV3(): TemplatePackageV3 {
  const capabilityPolicy = {
    requiredCapabilities: [
      "create_binding",
      "resume_binding",
      "input_correlation",
      "provider_receipt",
      "reconcile",
      "interrupt",
    ] as const,
    allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
    permissionMode: "ask" as const,
    maxConcurrentTurns: 1,
    maxNativeChildren: 0,
  };
  return {
    schemaVersion: 3,
    kind: "agent-workspace/template",
    template: {
      templateId: "template_acp-v3",
      version: 1,
      slug: "acp-v3",
      title: "ACP v3",
    },
    definition: {
      schemaVersion: 3,
      conductor: {
        agentCardId: "agent_card_conductor",
        kind: "conductor",
        title: "Conductor",
        executionProfileId: "profile_conductor",
        systemPrompt: "Coordinate bounded work through the four scoped tools.",
        capabilityRefs: [],
      },
      agentCards: [{
        agentCardId: "agent_card_worker",
        kind: "implementer",
        title: "Worker",
        executionProfileId: "profile_worker",
        systemPrompt: "Implement only the supplied bounded task.",
        capabilityRefs: [],
        dispatchProfile: { title: "Implementation", description: "Use for bounded implementation work." },
      }],
      executionProfiles: [{
        executionProfileId: "profile_conductor",
        profileRevisionId: "profile_revision_conductor-1",
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        protocolMajor: 1,
        model: "current-configured-model",
        configIntent: { reasoningEffort: "high" },
        requiredExtensions: ["session/load"],
        capabilityPolicy,
      }, {
        executionProfileId: "profile_worker",
        profileRevisionId: "profile_revision_worker-1",
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        protocolMajor: 1,
        model: "current-configured-model",
        configIntent: {},
        requiredExtensions: [],
        capabilityPolicy: { ...capabilityPolicy, allowedTools: [] },
      }],
      routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 2, maxDispatchesPerDecision: 2 },
      deliverables: [{ artifactPath: "reports/result.md", ownerAgentCardId: "agent_card_worker" }],
    },
  };
}
