import {
  hashDefinition,
  validateTemplatePackageSnapshot,
  validateTemplatePackageV3,
  type JsonValue,
  type AgentCardDefinition,
  type ExecutionProfileDefinitionV3,
  type TemplatePackageSnapshot,
  type TemplatePackageV3,
  type TemplateRecord,
  type TemplateVersionRecord,
} from "@agent-workspace/runtime-contracts";
import type { RuntimeRepositories } from "@agent-workspace/runtime-store";

export const BUILT_IN_OPENCODE_ACP_STARTER_TEMPLATE_ID = "template_builtin-opencode-acp-starter";
export const BUILT_IN_OPENCODE_ACP_STARTER_TEMPLATE_VERSION_ID = "template_version_builtin-opencode-acp-starter-v1";
export const BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID = "template_builtin-codex-acp-starter";
export const BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID = "template_version_builtin-codex-acp-starter-v1";
export const BUILT_IN_CLAUDE_CODE_ACP_STARTER_TEMPLATE_ID = "template_builtin-claude-code-acp-starter";
export const BUILT_IN_CLAUDE_CODE_ACP_STARTER_TEMPLATE_VERSION_ID = "template_version_builtin-claude-code-acp-starter-v1";
export const BUILT_IN_DEEPSEARCH_TEMPLATE_ID = "template_builtin-deepsearch";
export const BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID = "template_version_builtin-deepsearch-v1";

const DEEPSEARCH_ROLES = ["conductor", "researcher", "reviewer", "publisher"] as const;

const DEPRECATED_BUILT_IN_TEMPLATE_IDS = Object.freeze([
  BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID,
  BUILT_IN_CLAUDE_CODE_ACP_STARTER_TEMPLATE_ID,
  BUILT_IN_OPENCODE_ACP_STARTER_TEMPLATE_ID,
]);

/**
 * The product ships one useful starting point instead of one generic example
 * per Provider. Provider selection remains a Profile concern inside a real
 * Template; it is not a reason to create placeholder Templates in the Library.
 */
export const BUILT_IN_TEMPLATE_PACKAGES: readonly Readonly<{
  templateVersionId: string;
  package: TemplatePackageV3;
}>[] = Object.freeze([
  Object.freeze({
    templateVersionId: BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
    package: validateTemplatePackageV3({
      schemaVersion: 3,
      kind: "agent-workspace/template",
      template: {
        templateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
        version: 1,
        slug: "deepsearch",
        title: "Deepsearch",
        description: "A complete research workflow: investigate, review the evidence, and publish one traceable report.",
      },
      definition: deepsearchDefinition(),
    }),
  }),
]);

/**
 * Provider-focused packages remain test fixtures for provider-neutral runtime
 * contracts. They are deliberately not installed into the product Library.
 */
export const BUILT_IN_ACP_STARTER_PACKAGES: readonly Readonly<{
  templateVersionId: string;
  package: TemplatePackageV3;
}>[] = Object.freeze([
  Object.freeze({
    templateVersionId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_VERSION_ID,
    package: validateTemplatePackageV3({
      schemaVersion: 3,
      kind: "agent-workspace/template",
      template: {
        templateId: BUILT_IN_CODEX_ACP_STARTER_TEMPLATE_ID,
        version: 1,
        slug: "codex-acp-starter",
        title: "Codex ACP Starter",
        description: "The default portable managed Task starter, resolved against the current Host installation through Codex ACP.",
      },
      definition: acpStarterDefinition({
        providerFamily: "codex",
        acpAgentKind: "codex_acp",
        profileStem: "codex-acp-starter",
        model: "gpt-5.6-luna",
        cardPrefix: "codex-acp",
      }),
    }),
  }),
  Object.freeze({
    templateVersionId: BUILT_IN_CLAUDE_CODE_ACP_STARTER_TEMPLATE_VERSION_ID,
    package: validateTemplatePackageV3({
      schemaVersion: 3,
      kind: "agent-workspace/template",
      template: {
        templateId: BUILT_IN_CLAUDE_CODE_ACP_STARTER_TEMPLATE_ID,
        version: 1,
        slug: "claude-code-acp-starter",
        title: "Claude Code ACP Starter",
        description: "A portable managed Task starter resolved against the current Host installation through Claude Code ACP.",
      },
      definition: acpStarterDefinition({
        providerFamily: "claude-code",
        acpAgentKind: "claude_agent_acp",
        profileStem: "claude-code-acp-starter",
        model: "claude-opus-5[1M]",
        cardPrefix: "claude-code-acp",
      }),
    }),
  }),
  Object.freeze({
    templateVersionId: BUILT_IN_OPENCODE_ACP_STARTER_TEMPLATE_VERSION_ID,
    package: validateTemplatePackageV3({
      schemaVersion: 3,
      kind: "agent-workspace/template",
      template: {
        templateId: BUILT_IN_OPENCODE_ACP_STARTER_TEMPLATE_ID,
        version: 1,
        slug: "opencode-acp-starter",
        title: "OpenCode ACP Starter",
        description: "A portable managed Task starter resolved against the current Host installation through OpenCode ACP.",
      },
      definition: acpStarterDefinition({
        providerFamily: "opencode",
        acpAgentKind: "native_acp",
        profileStem: "opencode-acp-starter",
        model: "opencode-go/gpt-5.6-luna",
        cardPrefix: "opencode-acp",
      }),
    }),
  }),
]);

export type BuiltInTemplateProfileOption = Readonly<{
  title: string;
  sourceTemplateId: string;
  sourceTemplateVersionId: string;
  role: AgentCardDefinition["kind"];
  profile: ExecutionProfileDefinitionV3;
}>;

/**
 * Host-owned Profile catalog for the real Deepsearch Template. These are
 * selectable execution revisions, not additional placeholder Templates.
 * Readiness remains a Host observation and is deliberately not embedded here.
 */
export const BUILT_IN_TEMPLATE_PROFILE_OPTIONS: readonly BuiltInTemplateProfileOption[] = Object.freeze([
  ...deepsearchProviderProfileOptions({
    providerFamily: "codex",
    acpAgentKind: "codex_acp",
    model: "gpt-5.6-luna",
  }),
  ...deepsearchProviderProfileOptions({
    providerFamily: "claude-code",
    acpAgentKind: "claude_agent_acp",
    model: "claude-opus-5[1M]",
  }),
  ...deepsearchProviderProfileOptions({
    providerFamily: "opencode",
    acpAgentKind: "native_acp",
    model: "opencode-go/gpt-5.6-luna",
  }),
]);

/**
 * Trusted Host bootstrap only. It has no renderer or Runtime Bridge entry
 * point, and uses the same immutable package persistence path as imports.
 */
export function installBuiltInTemplates(
  repositories: Pick<RuntimeRepositories, "templateTask">,
  now: string,
): void {
  for (const templateId of DEPRECATED_BUILT_IN_TEMPLATE_IDS) {
    const existing = repositories.templateTask.getTemplate(templateId);
    if (existing && !existing.archivedAt) {
      repositories.templateTask.archiveTemplate(templateId, existing.revision, now);
    }
  }
  const sources: readonly Readonly<{
    templateVersionId: string;
    package: TemplatePackageSnapshot;
  }>[] = BUILT_IN_TEMPLATE_PACKAGES;
  for (const source of sources) {
    const packageValue = validateTemplatePackageSnapshot(source.package);
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

function deepsearchDefinition(): TemplatePackageV3["definition"] {
  const profiles = Object.fromEntries(DEEPSEARCH_ROLES.map((role) => [
    role,
    acpStarterProfile({
      providerFamily: "codex",
      acpAgentKind: "codex_acp",
      model: "gpt-5.6-luna",
    }, {
      executionProfileId: `profile_deepsearch-${role}`,
      profileRevisionId: `profile_revision_deepsearch-${role}-v1`,
      allowedTools: role === "conductor"
        ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
        : [],
      permissionMode: "preapproved",
    }),
  ])) as Record<typeof DEEPSEARCH_ROLES[number], TemplatePackageV3["definition"]["executionProfiles"][number]>;

  return {
    schemaVersion: 3,
    taskInputSchema: {
      fields: [
        {
          fieldId: "research-question",
          kind: "long_text",
          label: "Research question",
          required: true,
          description: "The question the team must answer with traceable evidence.",
        },
        {
          fieldId: "scope-and-constraints",
          kind: "long_text",
          label: "Scope and constraints",
          required: false,
          description: "Time range, geography, exclusions, or decision constraints.",
        },
        {
          fieldId: "report-language",
          kind: "choice",
          label: "Report language",
          required: true,
          options: [
            { optionId: "zh-cn", label: "简体中文" },
            { optionId: "en", label: "English" },
          ],
        },
      ],
    },
    conductor: {
      agentCardId: "agent_card_deepsearch-conductor",
      kind: "conductor",
      title: "Deepsearch Conductor",
      role: "Owns the research conversation and routes evidence between specialist Sessions.",
      executionProfileId: profiles.conductor.executionProfileId,
      systemPrompt: [
        "Own one Deepsearch Task from question to reviewed report.",
        "Turn the user's request into explicit research assignments, use only the four scoped orchestration tools,",
        "send evidence snapshots to Reviewer before publication, and preserve uncertainty or conflicting sources.",
        "Never mark the Task achieved; achievement is an explicit user decision.",
      ].join(" "),
      capabilityRefs: [],
    },
    agentCards: [
      {
        agentCardId: "agent_card_deepsearch-researcher",
        kind: "researcher",
        title: "Researcher",
        role: "Finds primary evidence and records source-aware findings.",
        executionProfileId: profiles.researcher.executionProfileId,
        systemPrompt: [
          "Investigate only the assigned research question and scope.",
          "Prefer primary sources, distinguish observations from inference, preserve source details,",
          "and return concise findings, contradictions, gaps, and follow-up questions.",
        ].join(" "),
        capabilityRefs: [],
        dispatchProfile: {
          title: "Evidence research",
          description: "Use when a claim needs source discovery, comparison, or verification.",
        },
      },
      {
        agentCardId: "agent_card_deepsearch-reviewer",
        kind: "reviewer",
        title: "Reviewer",
        role: "Audits the selected evidence snapshot before it can be published.",
        executionProfileId: profiles.reviewer.executionProfileId,
        systemPrompt: [
          "Review only the evidence snapshot supplied by the Conductor.",
          "Check source quality, claim support, contradictions, missing context, and overstatement.",
          "Return a clear pass, revise, or insufficient-evidence decision with exact reasons.",
        ].join(" "),
        capabilityRefs: [],
        dispatchProfile: {
          title: "Evidence review",
          description: "Use after research to validate claims, provenance, uncertainty, and completeness.",
        },
      },
      {
        agentCardId: "agent_card_deepsearch-publisher",
        kind: "publisher",
        title: "Publisher",
        role: "Turns reviewed evidence into the user-facing report.",
        executionProfileId: profiles.publisher.executionProfileId,
        systemPrompt: [
          "Create the final report only from evidence that the Conductor identifies as reviewed.",
          "Keep citations or source references attached to claims, state unresolved limitations,",
          "and write a decision-ready report to reports/deepsearch-report.md.",
        ].join(" "),
        capabilityRefs: [],
        dispatchProfile: {
          title: "Reviewed report publication",
          description: "Use only after Reviewer acceptance to create the final traceable report.",
        },
      },
    ],
    executionProfiles: DEEPSEARCH_ROLES.map((role) => profiles[role]),
    routingPolicy: {
      mode: "agent_loop",
      maxConcurrentInvocations: 3,
      maxDispatchesPerDecision: 4,
    },
    deliverables: [{
      artifactPath: "reports/deepsearch-report.md",
      ownerAgentCardId: "agent_card_deepsearch-publisher",
      description: "A reviewed report with traceable sources, uncertainty, and unresolved limitations.",
    }],
  };
}

function deepsearchProviderProfileOptions(input: Readonly<{
  providerFamily: "opencode" | "codex" | "claude-code";
  acpAgentKind: "native_acp" | "codex_acp" | "claude_agent_acp";
  model: string;
}>): readonly BuiltInTemplateProfileOption[] {
  return Object.freeze(DEEPSEARCH_ROLES.map((role) => {
    const profileStem = input.providerFamily === "claude-code" ? "claude-code" : input.providerFamily;
    const defaultProfile = BUILT_IN_TEMPLATE_PACKAGES[0]!.package.definition.executionProfiles.find((candidate) =>
      candidate.executionProfileId === `profile_deepsearch-${role}`);
    const profile = input.providerFamily === "codex"
      ? requiredBuiltInProfile(defaultProfile)
      : acpStarterProfile(input, {
          executionProfileId: `profile_deepsearch-${profileStem}-${role}`,
          profileRevisionId: `profile_revision_deepsearch-${profileStem}-${role}-v1`,
          allowedTools: role === "conductor"
            ? ["invoke_agent", "send_to_session", "interrupt_session", "close_session"]
            : [],
          permissionMode: "preapproved",
        });
    return Object.freeze({
      title: `Deepsearch · ${providerTitle(input.providerFamily)} · ${role}`,
      sourceTemplateId: BUILT_IN_DEEPSEARCH_TEMPLATE_ID,
      sourceTemplateVersionId: BUILT_IN_DEEPSEARCH_TEMPLATE_VERSION_ID,
      role,
      profile: freezeExecutionProfile(profile),
    });
  }));
}

function requiredBuiltInProfile(
  profile: ExecutionProfileDefinitionV3 | undefined,
): ExecutionProfileDefinitionV3 {
  if (!profile) throw new Error("built_in_deepsearch_profile_missing");
  return profile;
}

function freezeExecutionProfile(profile: ExecutionProfileDefinitionV3): ExecutionProfileDefinitionV3 {
  return Object.freeze({
    ...profile,
    configIntent: Object.freeze({ ...profile.configIntent }),
    requiredExtensions: Object.freeze([...profile.requiredExtensions]),
    capabilityPolicy: Object.freeze({
      ...profile.capabilityPolicy,
      requiredCapabilities: Object.freeze([...profile.capabilityPolicy.requiredCapabilities]),
      allowedTools: Object.freeze([...profile.capabilityPolicy.allowedTools]),
    }),
  });
}

function acpStarterDefinition(input: Readonly<{
  providerFamily: "opencode" | "codex" | "claude-code";
  acpAgentKind: "native_acp" | "codex_acp" | "claude_agent_acp";
  profileStem: string;
  model: string;
  cardPrefix: string;
}>): TemplatePackageV3["definition"] {
  const conductorExecutionProfileId = `profile_${input.profileStem}-conductor`;
  const workerExecutionProfileId = `profile_${input.profileStem}-worker`;
  return {
    schemaVersion: 3,
    conductor: {
      agentCardId: `agent_card_${input.cardPrefix}-conductor`,
      kind: "conductor",
      title: `${providerTitle(input.providerFamily)} ACP Conductor`,
      role: "Coordinates the user-owned Task and dispatches bounded work.",
      executionProfileId: conductorExecutionProfileId,
      systemPrompt: "Coordinate one user-owned Task from explicit messages and durable Runtime evidence. Dispatch bounded assignments, preserve uncertainty, and never mark the Task achieved: achievement is an explicit user decision.",
      capabilityRefs: [],
    },
    agentCards: [{
      agentCardId: `agent_card_${input.cardPrefix}-worker`,
      kind: "general",
      title: `${providerTitle(input.providerFamily)} ACP Worker`,
      role: "Handles one scoped assignment when the Conductor dispatches it.",
      executionProfileId: workerExecutionProfileId,
      systemPrompt: "Handle only the assigned bounded work. Return concise evidence, limitations, and next steps. Never infer that the user accepted or achieved the Task.",
      capabilityRefs: [],
      dispatchProfile: {
        title: "Bounded ACP assignment",
        description: "Use for one explicitly scoped analysis, implementation, or verification assignment.",
      },
    }],
    executionProfiles: [
      acpStarterProfile(input, {
        executionProfileId: conductorExecutionProfileId,
        profileRevisionId: `profile_revision_${input.profileStem}-conductor-v1`,
        allowedTools: ["invoke_agent", "send_to_session", "interrupt_session", "close_session"],
      }),
      acpStarterProfile(input, {
        executionProfileId: workerExecutionProfileId,
        profileRevisionId: `profile_revision_${input.profileStem}-worker-v1`,
        allowedTools: [],
      }),
    ],
    routingPolicy: { mode: "agent_loop", maxConcurrentInvocations: 1, maxDispatchesPerDecision: 1 },
    deliverables: [{
      artifactPath: "artifacts/result.md",
      ownerAgentCardId: `agent_card_${input.cardPrefix}-worker`,
      description: "Optional user-reviewed result of the bounded assignment.",
    }],
  };
}

function acpStarterProfile(
  input: Readonly<{
    providerFamily: "opencode" | "codex" | "claude-code";
    acpAgentKind: "native_acp" | "codex_acp" | "claude_agent_acp";
    model: string;
  }>,
  identity: Readonly<{
    executionProfileId: string;
    profileRevisionId: string;
    allowedTools: readonly string[];
    permissionMode?: "ask" | "preapproved" | "deny";
  }>,
): TemplatePackageV3["definition"]["executionProfiles"][number] {
  return {
    executionProfileId: identity.executionProfileId,
    profileRevisionId: identity.profileRevisionId,
    providerFamily: input.providerFamily,
    acpAgentKind: input.acpAgentKind,
    protocolMajor: 1,
    model: input.model,
    configIntent: {},
    requiredExtensions: [],
    capabilityPolicy: {
      requiredCapabilities: [
        "create_binding",
        "resume_binding",
        "input_correlation",
        "provider_receipt",
        "reconcile",
        "interrupt",
      ],
      allowedTools: identity.allowedTools,
      permissionMode: identity.permissionMode ?? "ask",
      maxConcurrentTurns: 1,
      maxNativeChildren: 0,
    },
  };
}

function providerTitle(providerFamily: "opencode" | "codex" | "claude-code"): string {
  if (providerFamily === "opencode") return "OpenCode";
  if (providerFamily === "claude-code") return "Claude Code";
  return "Codex";
}
