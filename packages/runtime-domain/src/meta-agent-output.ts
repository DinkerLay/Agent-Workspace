import type {
  JsonObject,
  MetaPatchOperation,
  MetaPatchValidationIssue,
  MetaSessionMode,
} from "@agent-workspace/runtime-contracts";
import { invariant } from "./errors.js";

export type ParsedMetaAgentOutput = Readonly<{
  assistantMessage: string;
  proposal?: Readonly<{
    operations: readonly MetaPatchOperation[];
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
              objectSchema(["kind", "value"], {
                kind: { const: "template_conductor_prompt_set" },
                value: { type: "string", minLength: 1, maxLength: 32_000 },
              }),
              objectSchema(["kind", "agentCardId", "value"], {
                kind: { const: "template_card_prompt_set" },
                agentCardId: { type: "string", pattern: "^agent_card_" },
                value: { type: "string", minLength: 1, maxLength: 32_000 },
              }),
              objectSchema(["kind", "executionProfileId", "value"], {
                kind: { const: "template_profile_model_set" },
                executionProfileId: { type: "string", pattern: "^profile_" },
                value: { type: "string", minLength: 1, maxLength: 500 },
              }),
              objectSchema(["kind", "agentCardId", "executionProfileId"], {
                kind: { const: "template_card_profile_set" },
                agentCardId: { type: "string", pattern: "^agent_card_" },
                executionProfileId: { type: "string", pattern: "^profile_" },
              }),
              objectSchema(["kind", "artifactPath", "ownerAgentCardId"], {
                kind: { const: "template_deliverable_upsert" },
                artifactPath: { type: "string", minLength: 1, maxLength: 512 },
                ownerAgentCardId: { type: "string", pattern: "^agent_card_" },
                description: { type: "string", minLength: 1, maxLength: 2_000 },
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

function parseOperation(value: unknown, mode: MetaSessionMode): MetaPatchOperation {
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
    case "template_conductor_prompt_set": {
      const input = exactRecord(value, ["kind", "value"], "meta_provider_operation_invalid");
      return { kind, value: text(input.value, 32_000, "meta_provider_operation_value_invalid") };
    }
    case "template_card_prompt_set": {
      const input = exactRecord(value, ["kind", "agentCardId", "value"], "meta_provider_operation_invalid");
      return { kind, agentCardId: opaqueId(input.agentCardId, "agent_card_"), value: text(input.value, 32_000, "meta_provider_operation_value_invalid") };
    }
    case "template_profile_model_set": {
      const input = exactRecord(value, ["kind", "executionProfileId", "value"], "meta_provider_operation_invalid");
      return { kind, executionProfileId: opaqueId(input.executionProfileId, "profile_"), value: text(input.value, 500, "meta_provider_operation_value_invalid") };
    }
    case "template_card_profile_set": {
      const input = exactRecord(value, ["kind", "agentCardId", "executionProfileId"], "meta_provider_operation_invalid");
      return { kind, agentCardId: opaqueId(input.agentCardId, "agent_card_"), executionProfileId: opaqueId(input.executionProfileId, "profile_") };
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

function opaqueId(value: unknown, prefix: string): string {
  const normalized = text(value, 300, "meta_provider_operation_id_invalid");
  invariant(normalized.startsWith(prefix), "meta_provider_operation_id_invalid");
  return normalized;
}
