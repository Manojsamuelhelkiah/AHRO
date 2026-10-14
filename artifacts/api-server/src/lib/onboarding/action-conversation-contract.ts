import { createHash } from "node:crypto";

export const CONVERSATION_NOTICE = "Human annotations are not recorded case evidence. AI triage is read-only. Suggestions are not executed; no messages, assignments, escalations or approvals are dispatched.";
export const conversationDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** asOf is a collection clock, not an evidence revision. All actual excerpts,
 * limitations and projection identifiers participate in the revision. */
export function conversationEvidenceFingerprint(evidence: {
  caseId: number; sources: unknown[]; limitations: string[]; truncated: boolean; redactionIdentifiers: string[];
}) {
  return conversationDigest([evidence.caseId, evidence.sources, evidence.limitations, evidence.truncated, evidence.redactionIdentifiers]);
}

export function conversationIntent(text: string): "answer" | "clarification" | "proposal" {
  if (/\b(?:send|assign|escalate|remind|create|approve|reject|resolve|cancel|update|change|contact)\b/i.test(text)) return "proposal";
  if (/\b(?:laptop|equipment|device|badge)\b/i.test(text) && /\b(?:hasn.t|not|missing|arriv|delay)\b/i.test(text)) return "clarification";
  return "answer";
}

/** Mentions deliberately use exact catalogue keys, not ambiguous display names. */
export function resolveConversationMention(text: string, picker?: string): { key?: string; error?: string } {
  const mentions = [...text.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]*)\b/gi)].map(match => match[1].toLowerCase());
  const keys = [...new Set([...mentions, ...(picker ? [picker] : [])])];
  if (keys.length > 1) return { error: "Choose one exact catalogue role. Multiple or conflicting agent selections are not supported." };
  return { key: keys[0] };
}

export function interruptedConversationState(row: { state: string; updatedAt: Date }, now = Date.now()) {
  return row.state === "pending" && now - row.updatedAt.getTime() > 120_000 ? "uncertain" : row.state;
}
