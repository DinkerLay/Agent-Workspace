import type {
  AgentCardKind,
  AgentDispatchProfile,
  JsonObject,
  MetaPatchOperation,
  MetaPatchValidationIssue,
  MetaSessionMode,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors.js";

export type MetaPatchIntentOperation =
  | Exclude<MetaPatchOperation, Extract<MetaPatchOperation, {
      kind:
        | "template_card_create"
        | "template_card_update"
        | "template_card_reorder"
        | "template_conductor_prompt_set"
        | "template_card_prompt_set"
        | "template_card_profile_set"
        | "template_profile_model_set"
        | "template_profile_revision_set";
    }>>
  | Readonly<{
      kind: "template_card_create";
      proposalRef: string;
      cardKind: Exclude<AgentCardKind, "conductor">;
      title: string;
      role?: string;
      executionProfileId: string;
      systemPrompt: string;
      dispatchProfile: AgentDispatchProfile;
    }>
  | Readonly<{ kind: "template_card_reorder"; cardRefs: readonly string[] }>
  | Readonly<{
      kind: "template_card_update";
      agentCardId: string;
      title?: string;
      role?: string | null;
      executionProfileId?: string;
      dispatchProfile?: AgentDispatchProfile;
    }>
  | Readonly<{
      kind: "template_profile_revision_select";
      executionProfileId: string;
      profileRevisionId: string;
    }>;

export type ParsedMetaAgentOutput = Readonly<{
  assistantMessage: string;
  proposal?: Readonly<{
    operations: readonly MetaPatchIntentOperation[];
    summary: string;
    rationale: string;
    validationIssues: readonly MetaPatchValidationIssue[];
  }>;
}>;

/** Strict schema supplied to capable native providers; Runtime still parses again. */
export const META_AGENT_OUTPUT_SCHEMA: JsonObject = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["assistantMessage"],
  properties: {
    assistantMessage: { type: "string", minLength: 1, maxLength: 50_000 },
    proposal: {
      type: "object",
      additionalProperties: false,
      required: ["operations", "summary", "rationale", "validationIssues"],
      properties: {
        operations: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            oneOf: [
              objectSchema(["kind", "field", "value"], {
                kind: { const: "template_metadata_set" },
                field: { enum: ["title", "slug", "description"] },
                value: { type: ["string", "null"], maxLength: 2_000 },
              }),
              objectSchema(["kind", "oldText", "newText"], {
                kind: { const: "template_conductor_prompt_edit" },
                oldText: { type: "string", minLength: 1, maxLength: 8_000 },
                newText: { type: "string", maxLength: 8_000 },
              }),
              objectSchema(["kind", "proposalRef", "cardKind", "title", "executionProfileId", "systemPrompt", "dispatchProfile"], {
                kind: { const: "template_card_create" },
                proposalRef: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" },
                cardKind: { enum: ["general", "researcher", "implementer", "reviewer", "publisher"] },
                title: { type: "string", minLength: 1, maxLength: 160 },
                role: { type: "string", minLength: 1, maxLength: 500 },
                executionProfileId: { type: "string", pattern: "^profile_" },
                dispatchProfile: objectSchema(["title", "description"], {
                  title: { type: "string", minLength: 1, maxLength: 160 },
                  description: { type: "string", minLength: 1, maxLength: 2_000 },
                }),
              }),
              objectSchema(["kind", "agentCardId"], {
                kind: { const: "template_card_update" },
                agentCardId: { type: "string", pattern: "^agent_card_" },
                title: { type: "string", minLength: 1, maxLength: 160 },
                role: { type: ["string", "null"], minLength: 1, maxLength: 500 },
                executionProfileId: { type: "string", pattern: "^profile_" },
                systemPrompt: { type: "string", minLength: 1, maxLength: 50_000 },
                dispatchProfile: objectSchema(["title", "description"], {
                  title: { type: "string", minLength: 1, maxLength: 160 },
                  description: { type: "string", minLength: 1, maxLength: 2_000 },
                }),
              }),
              objectSchema(["kind", "agentCardId"], {
                kind: { const: "template_card_remove" },
                agentCardId: { type: "string", pattern: "^agent_card_" },
              }),
              objectSchema(["kind", "cardRefs"], {
                kind: { const: "template_card_reorder" },
                cardRefs: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1, maxLength: 256 },
                },
              }),
              objectSchema(["kind", "agentCardId", "oldText", "newText"], {
                kind: { const: "template_card_prompt_edit" },
                agentCardId: { type: "string", pattern: "^agent_card_" },
                oldText: { type: "string", minLength: 1, maxLength: 8_000 },
                newText: { type: "string", maxLength: 8_000 },
              }),
              objectSchema(["kind", "executionProfileId", "profileRevisionId"], {
                kind: { const: "template_profile_revision_select" },
                executionProfileId: { type: "string", pattern: "^profile_" },
                profileRevisionId: { type: "string", pattern: "^profile_revision_" },
              }),
              objectSchema(["kind", "artifactPath", "ownerAgentCardId"], {
                kind: { const: "template_deliverable_upsert" },
                artifactPath: { type: "string", minLength: 1, maxLength: 512 },
                ownerAgentCardId: { type: "string", pattern: "^agent_card_" },
                description: { type: "string", minLength: 1, maxLength: 2_000 },
              }),
              objectSchema(["kind", "artifactPath"], {
                kind: { const: "template_deliverable_remove" },
                artifactPath: { type: "string", minLength: 1, maxLength: 512 },
              }),
              objectSchema(["kind", "value"], {
                kind: { const: "task_setup_title_set" },
                value: { type: "string", minLength: 1, maxLength: 300 },
              }),
              objectSchema(["kind", "value"], {
                kind: { const: "task_setup_goal_set" },
                value: { type: "string", minLength: 1, maxLength: 16_000 },
              }),
              objectSchema(["kind", "fieldId", "value"], {
                kind: { const: "task_setup_input_set" },
                fieldId: { type: "string", minLength: 1, maxLength: 160 },
                value: { type: "string", maxLength: 50_000 },
              }),
            ],
          },
        },
        summary: { type: "string", minLength: 1, maxLength: 1_000 },
        rationale: { type: "string", minLength: 1, maxLength: 4_000 },
        validationIssues: {
          type: "array",
          maxItems: 64,
          items: objectSchema(["code", "message"], {
            code: { type: "string", minLength: 1, maxLength: 160 },
            message: { type: "string", minLength: 1, maxLength: 1_000 },
            operationIndex: { type: "integer", minimum: 0, maximum: 63 },
          }),
        },
      },
    },
  },
});

function objectSchema(required: readonly string[], properties: JsonObject): JsonObject {
  return { type: "object", additionalProperties: false, required: [...required], properties };
}

export function parseMetaAgentOutput(finalText: string, mode: MetaSessionMode): ParsedMetaAgentOutput {
  invariant(typeof finalText === "string" && finalText.length <= 100_000, "meta_provider_final_invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalText.trim());
  } catch {
    throw new Error("meta_provider_final_invalid_json");
  }
  const root = exactRecord(parsed, ["assistantMessage", "proposal"], "meta_provider_final_invalid");
  const assistantMessage = text(root.assistantMessage, 50_000, "meta_provider_message_invalid");
  if (root.proposal === undefined) return Object.freeze({ assistantMessage });
  const proposal = exactRecord(
    root.proposal,
    ["operations", "summary", "rationale", "validationIssues"],
    "meta_provider_proposal_invalid",
  );
  invariant(Array.isArray(proposal.operations) && proposal.operations.length > 0 && proposal.operations.length <= 64, "meta_provider_operations_invalid");
  const operations = proposal.operations.map((operation) => parseOperation(operation, mode));
  invariant(Array.isArray(proposal.validationIssues) && proposal.validationIssues.length <= 64, "meta_provider_validation_issues_invalid");
  const validationIssues = proposal.validationIssues.map(parseValidationIssue);
  return Object.freeze({
    assistantMessage,
    proposal: Object.freeze({
      operations: Object.freeze(operations),
      summary: text(proposal.summary, 1_000, "meta_provider_summary_invalid"),
      rationale: text(proposal.rationale, 4_000, "meta_provider_rationale_invalid"),
      validationIssues: Object.freeze(validationIssues),
    }),
  });
}

/** Validates one durable Template MCP mutation with the same parser used for Provider final output. */
export function parseMetaPatchIntentOperation(value: unknown): MetaPatchIntentOperation {
  return parseOperation(value, "template_design");
}

function parseOperation(value: unknown, mode: MetaSessionMode): MetaPatchIntentOperation {
  const base = record(value, "meta_provider_operation_invalid");
  const kind = text(base.kind, 100, "meta_provider_operation_kind_invalid");
  invariant(kind.startsWith(mode === "template_design" ? "template_" : "task_setup_"), "meta_session_mode_mismatch");
  switch (kind) {
    case "template_metadata_set": {
      const input = exactRecord(value, ["kind", "field", "value"], "meta_provider_operation_invalid");
      invariant(input.field === "title" || input.field === "slug" || input.field === "description", "meta_provider_operation_field_invalid");
      invariant(input.value === null || typeof input.value === "string", "meta_provider_operation_value_invalid");
      return { kind, field: input.field, value: input.value };
    }
    case "template_conductor_prompt_edit": {
      const input = exactRecord(value, ["kind", "oldText", "newText"], "meta_provider_operation_invalid");
      return {
        kind,
        oldText: rawText(input.oldText, 8_000, false, "meta_provider_operation_value_invalid"),
        newText: rawText(input.newText, 8_000, true, "meta_provider_operation_value_invalid"),
      };
    }
    case "template_card_create": {
      const input = exactRecord(value, ["kind", "proposalRef", "cardKind", "title", "role", "executionProfileId", "systemPrompt", "dispatchProfile"], "meta_provider_operation_invalid");
      const proposalRef = text(input.proposalRef, 80, "meta_provider_operation_value_invalid");
      invariant(/^[a-z][a-z0-9_-]{0,79}$/u.test(proposalRef) && !proposalRef.startsWith("agent_card_"), "meta_provider_operation_value_invalid");
      const cardKind = text(input.cardKind, 40, "meta_provider_operation_value_invalid");
      invariant(cardKind === "general" || cardKind === "researcher" || cardKind === "implementer" || cardKind === "reviewer" || cardKind === "publisher", "meta_provider_operation_value_invalid");
      return {
        kind,
        proposalRef,
        cardKind,
        title: text(input.title, 160, "meta_provider_operation_value_invalid"),
        ...(input.role === undefined ? {} : { role: text(input.role, 500, "meta_provider_operation_value_invalid") }),
        executionProfileId: opaqueId(input.executionProfileId, "profile_"),
        systemPrompt: text(input.systemPrompt, 50_000, "meta_provider_operation_value_invalid"),
        dispatchProfile: parseDispatchProfile(input.dispatchProfile),
      };
    }
    case "template_card_update": {
      const input = exactRecord(value, ["kind", "agentCardId", "title", "role", "executionProfileId", "dispatchProfile"], "meta_provider_operation_invalid");
      invariant(input.title !== undefined || input.role !== undefined || input.executionProfileId !== undefined || input.dispatchProfile !== undefined, "meta_provider_operation_value_invalid");
      return {
        kind,
        agentCardId: opaqueId(input.agentCardId, "agent_card_"),
        ...(input.title === undefined ? {} : { title: text(input.title, 160, "meta_provider_operation_value_invalid") }),
        ...(input.role === undefined ? {} : { role: input.role === null ? null : text(input.role, 500, "meta_provider_operation_value_invalid") }),
        ...(input.executionProfileId === undefined ? {} : { executionProfileId: opaqueId(input.executionProfileId, "profile_") }),
        ...(input.dispatchProfile === undefined ? {} : { dispatchProfile: parseDispatchProfile(input.dispatchProfile) }),
      };
    }
    case "template_card_remove": {
      const input = exactRecord(value, ["kind", "agentCardId"], "meta_provider_operation_invalid");
      return { kind, agentCardId: opaqueId(input.agentCardId, "agent_card_") };
    }
    case "template_card_reorder": {
      const input = exactRecord(value, ["kind", "cardRefs"], "meta_provider_operation_invalid");
      invariant(Array.isArray(input.cardRefs) && input.cardRefs.length > 0 && input.cardRefs.length <= 64, "meta_provider_operation_value_invalid");
      const cardRefs = input.cardRefs.map((candidate) => text(candidate, 256, "meta_provider_operation_value_invalid"));
      invariant(new Set(cardRefs).size === cardRefs.length, "meta_provider_operation_value_invalid");
      return { kind, cardRefs };
    }
    case "template_card_prompt_edit": {
      const input = exactRecord(value, ["kind", "agentCardId", "oldText", "newText"], "meta_provider_operation_invalid");
      return {
        kind,
        agentCardId: opaqueId(input.agentCardId, "agent_card_"),
        oldText: rawText(input.oldText, 8_000, false, "meta_provider_operation_value_invalid"),
        newText: rawText(input.newText, 8_000, true, "meta_provider_operation_value_invalid"),
      };
    }
    case "template_profile_revision_select": {
      const input = exactRecord(value, ["kind", "executionProfileId", "profileRevisionId"], "meta_provider_operation_invalid");
      return {
        kind,
        executionProfileId: opaqueId(input.executionProfileId, "profile_"),
        profileRevisionId: opaqueId(input.profileRevisionId, "profile_revision_"),
      };
    }
    case "template_deliverable_upsert": {
      const input = exactRecord(value, ["kind", "artifactPath", "ownerAgentCardId", "description"], "meta_provider_operation_invalid");
      return {
        kind,
        artifactPath: text(input.artifactPath, 512, "meta_provider_operation_value_invalid"),
        ownerAgentCardId: opaqueId(input.ownerAgentCardId, "agent_card_"),
        ...(input.description === undefined ? {} : { description: text(input.description, 2_000, "meta_provider_operation_value_invalid") }),
      };
    }
    case "template_deliverable_remove": {
      const input = exactRecord(value, ["kind", "artifactPath"], "meta_provider_operation_invalid");
      return {
        kind,
        artifactPath: text(input.artifactPath, 512, "meta_provider_operation_value_invalid"),
      };
    }
    case "task_setup_title_set":
    case "task_setup_goal_set": {
      const input = exactRecord(value, ["kind", "value"], "meta_provider_operation_invalid");
      return { kind, value: text(input.value, kind === "task_setup_title_set" ? 300 : 16_000, "meta_provider_operation_value_invalid") };
    }
    case "task_setup_input_set": {
      const input = exactRecord(value, ["kind", "fieldId", "value"], "meta_provider_operation_invalid");
      return { kind, fieldId: text(input.fieldId, 160, "meta_provider_operation_field_invalid"), value: text(input.value, 50_000, "meta_provider_operation_value_invalid") };
    }
    default:
      throw new Error("meta_provider_operation_kind_invalid");
  }
}

function parseDispatchProfile(value: unknown): AgentDispatchProfile {
  const input = exactRecord(value, ["title", "description"], "meta_provider_operation_invalid");
  return {
    title: text(input.title, 160, "meta_provider_operation_value_invalid"),
    description: text(input.description, 2_000, "meta_provider_operation_value_invalid"),
  };
}

function parseValidationIssue(value: unknown): MetaPatchValidationIssue {
  const input = exactRecord(value, ["code", "message", "operationIndex"], "meta_provider_validation_issue_invalid");
  invariant(input.operationIndex === undefined || (Number.isSafeInteger(input.operationIndex) && Number(input.operationIndex) >= 0), "meta_provider_validation_issue_invalid");
  return {
    code: text(input.code, 160, "meta_provider_validation_issue_invalid"),
    message: text(input.message, 1_000, "meta_provider_validation_issue_invalid"),
    ...(input.operationIndex === undefined ? {} : { operationIndex: Number(input.operationIndex) }),
  };
}

function exactRecord(value: unknown, allowed: readonly string[], code: string): Record<string, unknown> {
  const input = record(value, code);
  invariant(Object.keys(input).every((key) => allowed.includes(key)), code);
  return input;
}

function record(value: unknown, code: string): Record<string, unknown> {
  invariant(Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, code);
  return value as Record<string, unknown>;
}

function text(value: unknown, maximum: number, code: string): string {
  invariant(typeof value === "string" && Boolean(value.trim()) && value.trim().length <= maximum, code);
  return value.trim();
}

function rawText(value: unknown, maximum: number, allowEmpty: boolean, code: string): string {
  invariant(typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0), code);
  return value;
}

function opaqueId(value: unknown, prefix: string): string {
  const normalized = text(value, 300, "meta_provider_operation_id_invalid");
  invariant(normalized.startsWith(prefix), "meta_provider_operation_id_invalid");
  return normalized;
}
