import {
  hashDefinition,
  validateTemplatePackage,
  type JsonValue,
  type TemplatePackage,
  type TemplateRecord,
  type TemplateVersionRecord,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeRepositories } from "@agent-workspace/runtime-store";

/**
 * Stable IDs make installation safe to retry on every Host start. A user may
 * create a Draft from this version, but the built-in source is never rewritten.
 */
export const BUILT_IN_CODEX_STARTER_TEMPLATE_ID = "template_builtin-codex-starter";
export const BUILT_IN_CODEX_STARTER_TEMPLATE_VERSION_ID = "template_version_builtin-codex-starter-v1";

const BUILT_IN_TEMPLATE_PACKAGES = Object.freeze([{
  templateVersionId: BUILT_IN_CODEX_STARTER_TEMPLATE_VERSION_ID,
  package: {
    schemaVersion: 2,
    kind: "agent-workspace/template",
    template: {
      templateId: BUILT_IN_CODEX_STARTER_TEMPLATE_ID,
      version: 1,
      slug: "codex-starter",
      title: "Codex Starter",
      description: "A safe, single-worker Codex setup. Create a Task, authorize its cwd, then Start it and send the work request in the Task composer.",
    },
    definition: {
      schemaVersion: 2,
      conductor: {
        agentCardId: "agent_card_codex-conductor",
        kind: "conductor",
        title: "Codex Conductor",
        role: "Coordinates the user-owned Task and keeps the work bounded.",
        executionProfileId: "profile_codex-starter",
        systemPrompt: "You coordinate one user-owned Task. Work only from the user's explicit Task messages and the authorized workspace context. This starter permits no tools. State useful findings and next steps clearly. You must never mark a Task achieved: achievement is an explicit user decision.",
        capabilityRefs: [],
      },
      agentCards: [{
        agentCardId: "agent_card_codex-worker",
        kind: "general",
        title: "Codex Worker",
        role: "Handles one scoped assignment when the Conductor dispatches it.",
        executionProfileId: "profile_codex-starter",
        systemPrompt: "Handle only the assigned, bounded work. Do not use tools in this starter. Return concise evidence, limitations, and suggested next steps. Never infer that the user accepted or achieved the Task.",
        capabilityRefs: [],
        dispatchProfile: {
          title: "Bounded Codex assignment",
          description: "Use for one explicitly scoped implementation, analysis, or verification assignment delegated by the Conductor.",
        },
      }],
      executionProfiles: [{
        executionProfileId: "profile_codex-starter",
        provider: "codex",
        model: "gpt-5.4",
        providerVersion: "0.146.0",
        protocolFingerprint: "sha256:28161abf152e09a7a4c47427e9098a2407b048f5d16c099a4ec9cb282fbf8448",
        capabilityPolicy: {
          requiredCapabilities: ["create_binding", "resume_binding", "input_correlation", "provider_receipt", "reconcile", "interrupt"],
          allowedTools: [],
          permissionMode: "deny",
          maxConcurrentTurns: 1,
          maxNativeChildren: 0,
        },
      }],
      routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
      deliverables: [{
        artifactPath: "artifacts/summary.md",
        ownerAgentCardId: "agent_card_codex-worker",
        description: "Optional user-reviewed summary of the bounded assignment.",
      }],
    },
  } satisfies TemplatePackage,
}]);

/**
 * Trusted Host bootstrap only. It has no renderer or Runtime Bridge entry
 * point, and uses the same immutable package persistence path as imports.
 */
export function installBuiltInTemplates(
  repositories: Pick<RuntimeRepositories, "templateTask">,
  now: string,
): void {
  for (const source of BUILT_IN_TEMPLATE_PACKAGES) {
    const packageValue = validateTemplatePackage(source.package);
    const definitionHash = hashDefinition(packageValue.definition as unknown as JsonValue);
    const template: TemplateRecord = {
      templateId: packageValue.template.templateId,
      slug: packageValue.template.slug,
      title: packageValue.template.title,
      ...(packageValue.template.description ? { description: packageValue.template.description } : {}),
      activeVersionId: source.templateVersionId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const version: TemplateVersionRecord = {
      templateVersionId: source.templateVersionId,
      templateId: packageValue.template.templateId,
      version: packageValue.template.version,
      definition: packageValue.definition,
      definitionHash,
      createdAt: now,
      publishedAt: now,
    };
    repositories.templateTask.importPackage(template, version, packageValue, []);
  }
}
