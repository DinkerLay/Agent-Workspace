import { hashDefinition } from "../../runtime-contracts/src";

/** Bump only when the grammar or its semantic interpretation changes. */
export const RELAY_PARSER_VERSION = 1;
export const MAX_RELAY_BLOCKS_PER_MESSAGE = 32;
export const MAX_RELAY_BLOCK_CHARACTERS = 16_384;

export type CanonicalRelayBlock = Readonly<{
  relayBlockId: string;
  sourceMessageId: string;
  ordinal: number;
  suggestedTargetAgentCardIds: readonly string[];
  suggestedAudience?: "one" | "publish";
  topic?: string;
  format: "text/markdown" | "application/json";
  content: string;
  contentDigest: string;
  parserVersion: number;
  sourceRange: Readonly<{ start: number; end: number }>;
  createdAt: string;
}>;

/**
 * Extracts only the canonical fenced relay grammar from immutable final
 * content. Malformed blocks remain ordinary text and therefore grant no
 * routing authority.
 */
export function extractCanonicalRelayBlocks(input: Readonly<{
  messageId: string;
  content: string;
  createdAt: string;
}>): readonly CanonicalRelayBlock[] {
  const blocks: CanonicalRelayBlock[] = [];
  const opening = /^```relay[\t ]*\r?\n/gm;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(input.content)) !== null && blocks.length < MAX_RELAY_BLOCKS_PER_MESSAGE) {
    const start = match.index;
    const bodyStart = opening.lastIndex;
    const closing = findClosingFence(input.content, bodyStart);
    if (!closing) continue;
    opening.lastIndex = closing.end;
    const parsed = parseRelayBody(input.content.slice(bodyStart, closing.start));
    if (!parsed) continue;
    const sourceRange = Object.freeze({ start, end: closing.end });
    const ordinal = blocks.length;
    const contentDigest = hashDefinition(parsed.content);
    blocks.push(Object.freeze({
      relayBlockId: deterministicRelayBlockId({
        sourceMessageId: input.messageId,
        ordinal,
        sourceRange,
        contentDigest,
        parserVersion: RELAY_PARSER_VERSION,
      }),
      sourceMessageId: input.messageId,
      ordinal,
      suggestedTargetAgentCardIds: Object.freeze([...parsed.suggestedTargetAgentCardIds]),
      ...(parsed.suggestedAudience ? { suggestedAudience: parsed.suggestedAudience } : {}),
      ...(parsed.topic ? { topic: parsed.topic } : {}),
      format: parsed.format,
      content: parsed.content,
      contentDigest,
      parserVersion: RELAY_PARSER_VERSION,
      sourceRange,
      createdAt: input.createdAt,
    }));
  }
  return Object.freeze(blocks);
}

function findClosingFence(source: string, from: number): Readonly<{ start: number; end: number }> | undefined {
  const closing = /^```[\t ]*(?:\r?\n|$)/gm;
  closing.lastIndex = from;
  const match = closing.exec(source);
  return match ? Object.freeze({ start: match.index, end: closing.lastIndex }) : undefined;
}

function parseRelayBody(rawBody: string): Readonly<{
  suggestedTargetAgentCardIds: readonly string[];
  suggestedAudience?: "one" | "publish";
  topic?: string;
  format: "text/markdown" | "application/json";
  content: string;
}> | undefined {
  if (rawBody.length > MAX_RELAY_BLOCK_CHARACTERS || /^```relay[\t ]*$/m.test(rawBody)) return undefined;
  const divider = /^---[\t ]*\r?$/m.exec(rawBody);
  if (!divider || divider.index === undefined) return undefined;
  const headers = rawBody.slice(0, divider.index).replace(/\r\n/g, "\n");
  const content = rawBody.slice(divider.index + divider[0].length).replace(/^\r?\n/, "");
  if (!content.trim()) return undefined;
  const values = new Map<string, string>();
  for (const line of headers.split("\n")) {
    if (!line) continue;
    const match = /^([a-z]+):[\t ]*(.*)$/.exec(line);
    if (!match) return undefined;
    const key = match[1]!;
    const value = match[2]!.trim();
    if (!RELAY_HEADER_KEYS.has(key) || !value || values.has(key)) return undefined;
    values.set(key, value);
  }
  const format = values.get("format") ?? "text/markdown";
  if (format !== "text/markdown" && format !== "application/json") return undefined;
  const topic = values.get("topic");
  if (topic && topic.length > 160) return undefined;
  const suggestedTargetAgentCardIds = (values.get("to") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (new Set(suggestedTargetAgentCardIds).size !== suggestedTargetAgentCardIds.length) return undefined;
  if (suggestedTargetAgentCardIds.some((id) => !id.startsWith("agent_card_"))) return undefined;
  const audience = values.get("audience");
  if (audience !== undefined && audience !== "one" && audience !== "publish") return undefined;
  return Object.freeze({
    suggestedTargetAgentCardIds: Object.freeze(suggestedTargetAgentCardIds),
    ...(audience ? { suggestedAudience: audience } : {}),
    ...(topic ? { topic } : {}),
    format,
    content,
  });
}

function deterministicRelayBlockId(input: Readonly<{
  sourceMessageId: string;
  ordinal: number;
  sourceRange: Readonly<{ start: number; end: number }>;
  contentDigest: string;
  parserVersion: number;
}>): string {
  const digest = hashDefinition(input).replace(/[^a-zA-Z0-9-]/g, "");
  return `relay_block_${digest}`;
}

const RELAY_HEADER_KEYS = new Set(["to", "audience", "topic", "format"]);
