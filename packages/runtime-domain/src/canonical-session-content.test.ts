import { describe, expect, it } from "vitest";
import { extractCanonicalRelayBlocks } from "./canonical-session-content.js";

const NOW = "2026-08-11T00:00:00.000Z";

describe("canonical Session final content", () => {
  it("extracts immutable relay candidates without granting routing authority", () => {
    const blocks = extractCanonicalRelayBlocks({
      messageId: "message_final",
      createdAt: NOW,
      content: [
        "private context",
        "```relay",
        "topic: review",
        "to: agent_card_reviewer",
        "audience: one",
        "---",
        "review this only",
        "```",
      ].join("\n"),
    });

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      sourceMessageId: "message_final",
      suggestedTargetAgentCardIds: ["agent_card_reviewer"],
      suggestedAudience: "one",
      topic: "review",
      content: "review this only\n",
    });
    expect(blocks[0]).not.toHaveProperty("targetSessionId");
    expect(blocks[0]).not.toHaveProperty("visibility");
  });

  it("keeps removed and malformed grammar as ordinary final text", () => {
    expect(extractCanonicalRelayBlocks({
      messageId: "message_final",
      createdAt: NOW,
      content: "```relay\nvisibility: shared\n---\nnot routable\n```",
    })).toEqual([]);
  });
});
