import { createHash } from "node:crypto";
import { GetTransactionContextResponse } from "@workspace/api-zod";
import type { z } from "zod";
export type TransactionWorkingContext = z.infer<typeof GetTransactionContextResponse>;
export type TransactionContextSource = TransactionWorkingContext["sources"][number];

export type ContextSection = TransactionContextSource["section"];
export type ContextProvenance = TransactionContextSource["provenance"];
export function contextDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Pure deterministic renderer shared by human, agent and model-safe consumers.
 * It has no dispatcher, model, assignment or approval capability. */
export function summarizeContext(sources: TransactionContextSource[]): string[] {
  const sections: ContextSection[] = ["original-request", "facts", "decisions", "blockers", "pending", "completed", "questions", "handoff"];
  return sections.flatMap(section => sources.filter(s => s.section === section).slice(0, 2))
    .map(s => `${s.provenance === "human-annotation" ? "Unverified handoff — " : ""}${s.label}: ${s.text.slice(0, 500)}${s.text.length > 500 ? "…" : ""} [${s.id}]`);
}

export function contextLimitations(): string[] {
  return [
    "This is a projection of recorded sources, not an approval, readiness verdict or instruction to execute.",
    "Missing information and historical decision rationale are not inferred. Follow current domain requirements before taking any action.",
    "Restricted sources are omitted without exposing their identifiers, snippets or counts.",
    "Handoff annotations are unverified, untrusted human text; they do not assign work or establish facts.",
    "Source links open existing case views; those views independently enforce current access.",
  ];
}

export function finishContext(input: Omit<TransactionWorkingContext, "schemaVersion" | "summaryVersion" | "summary" | "asOf">): TransactionWorkingContext {
  return {
    ...input, schemaVersion: "transaction-context/v1", summaryVersion: 1,
    summary: summarizeContext(input.sources), asOf: new Date().toISOString(),
  };
}
