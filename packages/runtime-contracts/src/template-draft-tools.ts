import type { JsonObject } from "./json";

export type TemplateDraftToolDefinition = Readonly<{
  name: string;
  description: string;
  inputSchema: JsonObject;
}>;

const exactObject = (required: readonly string[], properties: JsonObject): JsonObject => Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([...required]),
  properties,
});

/**
 * The only tool surface granted to a Template-design Meta Session. These
 * tools inspect or construct typed proposal operations; they never mutate the
 * Draft, publish a Version, create a Task, or expose filesystem authority.
 */
export const TEMPLATE_DRAFT_MCP_TOOL_DEFINITIONS: readonly TemplateDraftToolDefinition[] = Object.freeze([
  Object.freeze({
    name: "template_draft_read",
    description: "Read the current Template Draft or one stable Card/Profile target before proposing a change.",
    inputSchema: exactObject(["target"], {
      target: exactObject(["kind"], {
        kind: { enum: ["template", "conductor", "card", "profile"] },
        agentCardId: { type: "string", pattern: "^agent_card_" },
        executionProfileId: { type: "string", pattern: "^profile_" },
      }),
    }),
  }),
  Object.freeze({
    name: "template_draft_update_metadata",
    description: "Construct one targeted Template metadata field update without resending the Template definition.",
    inputSchema: exactObject(["field", "value"], {
      field: { enum: ["title", "slug", "description"] },
      value: { type: ["string", "null"], maxLength: 2_000 },
    }),
  }),
  Object.freeze({
    name: "template_draft_create_card",
    description: "Construct one proposal-local Agent Card creation operation. Runtime allocates the durable Card ID only when the proposal returns.",
    inputSchema: exactObject([
      "proposalRef", "cardKind", "title", "executionProfileId", "systemPrompt", "dispatchProfile",
    ], {
      proposalRef: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,79}$" },
      cardKind: { enum: ["general", "researcher", "implementer", "reviewer", "publisher"] },
      title: { type: "string", minLength: 1, maxLength: 160 },
      role: { type: "string", minLength: 1, maxLength: 500 },
      executionProfileId: { type: "string", pattern: "^profile_" },
      systemPrompt: { type: "string", minLength: 1, maxLength: 50_000 },
      dispatchProfile: exactObject(["title", "description"], {
        title: { type: "string", minLength: 1, maxLength: 160 },
        description: { type: "string", minLength: 1, maxLength: 2_000 },
      }),
    }),
  }),
  Object.freeze({
    name: "template_draft_update_card",
    description: "Construct a targeted scalar update for one existing Agent Card without resending the whole Template.",
    inputSchema: exactObject(["agentCardId", "changes"], {
      agentCardId: { type: "string", pattern: "^agent_card_" },
      changes: exactObject([], {
        title: { type: "string", minLength: 1, maxLength: 160 },
        role: { type: ["string", "null"], minLength: 1, maxLength: 500 },
        executionProfileId: { type: "string", pattern: "^profile_" },
        dispatchProfile: exactObject(["title", "description"], {
          title: { type: "string", minLength: 1, maxLength: 160 },
          description: { type: "string", minLength: 1, maxLength: 2_000 },
        }),
      }),
    }),
  }),
  Object.freeze({
    name: "template_draft_edit_prompt",
    description: "Replace one uniquely matching Prompt fragment. Use this for small edits instead of regenerating the complete Prompt.",
    inputSchema: exactObject(["target", "oldText", "newText"], {
      target: exactObject(["kind"], {
        kind: { enum: ["conductor", "card"] },
        agentCardId: { type: "string", pattern: "^agent_card_" },
      }),
      oldText: { type: "string", minLength: 1, maxLength: 8_000 },
      newText: { type: "string", maxLength: 8_000 },
    }),
  }),
  Object.freeze({
    name: "template_draft_delete_card",
    description: "Construct deletion of one existing non-Conductor Card when no deliverable still owns it.",
    inputSchema: exactObject(["agentCardId"], {
      agentCardId: { type: "string", pattern: "^agent_card_" },
    }),
  }),
  Object.freeze({
    name: "template_draft_reorder_cards",
    description: "Construct the complete ordered Card list after a reorder, using existing Card IDs and proposal-local refs created earlier in this MetaTurn.",
    inputSchema: exactObject(["cardRefs"], {
      cardRefs: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        uniqueItems: true,
        items: { type: "string", pattern: "^(?:agent_card_[A-Za-z0-9-]+|[a-z][a-z0-9_-]{0,79})$" },
      },
    }),
  }),
  Object.freeze({
    name: "template_draft_select_profile",
    description: "Select one Host-issued Provider/Model/Effort Profile revision for an existing executionProfileId.",
    inputSchema: exactObject(["executionProfileId", "profileRevisionId"], {
      executionProfileId: { type: "string", pattern: "^profile_" },
      profileRevisionId: { type: "string", pattern: "^profile_revision_" },
    }),
  }),
  Object.freeze({
    name: "template_draft_upsert_deliverable",
    description: "Construct one create-or-update operation for a Template deliverable owned by an existing Agent Card.",
    inputSchema: exactObject(["artifactPath", "ownerAgentCardId"], {
      artifactPath: { type: "string", minLength: 1, maxLength: 512 },
      ownerAgentCardId: { type: "string", pattern: "^agent_card_" },
      description: { type: "string", minLength: 1, maxLength: 2_000 },
    }),
  }),
  Object.freeze({
    name: "template_draft_delete_deliverable",
    description: "Construct deletion of one existing Template deliverable by its stable workspace-relative artifact path.",
    inputSchema: exactObject(["artifactPath"], {
      artifactPath: { type: "string", minLength: 1, maxLength: 512 },
    }),
  }),
]);
