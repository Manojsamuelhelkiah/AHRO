import { z } from "zod";
import { authoredStatement, type SourceHandling } from "./source-handling";

/** These contracts describe fictional operations, never workforce execution evidence. */
export const TASK_IDS = ["access-inventory", "shared-accounts", "kt-access-exception", "access-closure", "asset-inventory", "asset-return"] as const;
export const TaskId = z.enum(TASK_IDS);
export const Correlation = z.object({
  caseId: z.number().int().positive(), generation: z.number().int().positive(),
  taskId: TaskId, taskRevision: z.number().int().positive(),
  reference: z.string().regex(/^OX-[a-f0-9]{48}$/),
}).strict();
export const Observation = z.object({
  kind: z.enum(["acknowledgment", "partial", "confirmation", "clarification", "refusal", "delay", "exception", "uncertain"]),
  confirmed: z.array(z.string().min(1).max(80)).max(30),
  outstanding: z.array(z.string().min(1).max(160)).max(30),
  question: z.string().max(600),
  explanation: z.string().max(800),
}).strict();
export type Observation = z.infer<typeof Observation>;
export type ExchangeCorrelation = z.infer<typeof Correlation>;
export type PilotTask = {
  id: typeof TASK_IDS[number]; label: string; revision: number; owner: string | null;
  dueAt: string; notBeforeAt: string | null; prerequisites: typeof TASK_IDS[number][];
  expected: string[]; confirmed: string[]; outstanding: string[];
  handling?: SourceHandling;
  status: "pending" | "acknowledged" | "partial" | "review" | "resolved";
  evidence: Array<{ type: "email-source-attestation" | "authorized-human-attestation" | "simulated-api-response"; sourceId: string; actor: string; interpreter: string | null; generation: number; revision: number; recordedAt: string }>;
  exception: null | { revision: number; sourceId: string; explanation: string; disposition: string | null; reviewedBy: string | null };
};
export type Enrollment = {
  enabled: boolean; revision: number; generation: number; operator: string | null; agentId: string | null;
  mailbox: string | null; approvedAt: string | null;
  recipients: Array<{ taskId: typeof TASK_IDS[number]; memberId: string; address: string; persona: string; consentReference?: string; escalationMemberId: string; escalationAddress: string; escalationConsentReference?: string }>;
};
export type CommunicationChecks = { emailConsent: boolean; emailVerified: boolean; reviewRequired: boolean; basis: "client-declared"; changedBy: string | null; reviewedBy: string | null; reviewReference: string | null };
export type PilotState = { clock: string; tasks: PilotTask[]; enrollment: Enrollment; communicationChecks?: CommunicationChecks };
export const checksOf = (state: PilotState): CommunicationChecks => state.communicationChecks ?? {
  emailConsent: true, emailVerified: true, reviewRequired: false, basis: "client-declared", changedBy: null, reviewedBy: null, reviewReference: null,
};
export const communicationAllowed = (state: PilotState) => {
  const checks = checksOf(state);
  return state.enrollment.enabled && checks.emailConsent && checks.emailVerified && !checks.reviewRequired;
};
export const EnrollmentInput = z.object({
  expectedRevision: z.number().int().positive(), enabled: z.boolean(),
  agentId: z.string().min(1).max(160).optional(),
  recipients: z.array(z.object({
    taskId: TaskId, memberId: z.string().min(1).max(160), address: z.string().email().max(254),
    persona: z.string().min(1).max(160), consentReference: z.string().min(1).max(512).optional(),
    escalationMemberId: z.string().min(1).max(160), escalationAddress: z.string().email().max(254),
    escalationConsentReference: z.string().min(1).max(512).optional(),
  }).strict()).max(6),
  confirmCommunicationOnly: z.literal(true),
}).strict();

export function initialPilotState(dueAt: string): PilotState {
  const definition: Array<[PilotTask["id"], string, string[], PilotTask["id"][]]> = [
    ["access-inventory", "Confirm access inventory", ["Entra account", "shared account", "KT access"], []],
    ["shared-accounts", "Reassign shared account", ["shared account"], ["access-inventory"]],
    ["kt-access-exception", "Confirm temporary KT handling", ["KT access"], ["access-inventory"]],
    ["access-closure", "Remove access at end of last working day", ["Entra account"], ["shared-accounts", "kt-access-exception"]],
    ["asset-inventory", "Confirm equipment inventory", ["laptop", "charger"], []],
    ["asset-return", "Confirm equipment return", ["laptop", "charger"], ["asset-inventory"]],
  ];
  return {
    clock: new Date(Date.parse(dueAt) - 86400000).toISOString(),
    enrollment: { enabled: false, revision: 1, generation: 1, operator: null, agentId: null, mailbox: null, approvedAt: null, recipients: [] },
    tasks: definition.map(([id, label, expected, prerequisites]) => ({
      id, label, revision: 1, owner: null, dueAt, notBeforeAt: id === "access-closure" ? dueAt : null,
      prerequisites, expected, confirmed: [], outstanding: [...expected], status: "pending", evidence: [], exception: null,
    })),
  };
}

/** Bounded proposals do not authorize transitions. Unknown/contradictory portions fail closed. */
export function validateProposal(task: PilotTask, raw: unknown): Observation {
  const proposal = Observation.parse(raw);
  if (new Set(proposal.confirmed).size !== proposal.confirmed.length ||
      proposal.confirmed.some(v => !task.expected.includes(v)) ||
      proposal.confirmed.some(v => proposal.outstanding.includes(v))) throw new Error("Ambiguous or unknown confirmed portion.");
  if (proposal.kind === "confirmation" && task.expected.some(v => !task.confirmed.includes(v) && !proposal.confirmed.includes(v))) {
    return { ...proposal, kind: "partial", outstanding: task.expected.filter(v => !task.confirmed.includes(v) && !proposal.confirmed.includes(v)) };
  }
  if (["acknowledgment", "clarification", "refusal", "delay", "uncertain"].includes(proposal.kind) && proposal.confirmed.length) {
    throw new Error("Non-completion observation cannot confirm portions.");
  }
  return proposal;
}

/** Explicit completion phrase is independently bound into the signed body. */
export function explicitAttestation(body: string, reference: string, task: PilotTask): string[] | null {
  const authored = authoredStatement(body);
  const lines = authored.split(/\r?\n/).filter(l => !l.trim().startsWith(">"));
  const matches = lines.flatMap(line => {
    const m = line.trim().match(new RegExp(`^I confirm ${reference}: (.+)$`));
    return m ? [m[1].split(",").map(v => v.trim())] : [];
  });
  if (matches.length !== 1 || !matches[0].length || new Set(matches[0]).size !== matches[0].length ||
      matches[0].some(v => !task.expected.includes(v))) return null;
  // A negative about an unconfirmed portion is a partial result, not a contradiction.
  // Negatives about a confirmed portion or with no exact item remain ambiguous.
  const negative = /\b(not|haven't|hasn't|missing|damaged|unresolved|except|unable|refuse)\b/i;
  for (const sentence of authored.split(/[.!?\n]/).filter(s => negative.test(s))) {
    if (matches[0].some(v => sentence.toLowerCase().includes(v.toLowerCase())) ||
        !task.expected.some(v => !matches[0].includes(v) && sentence.toLowerCase().includes(v.toLowerCase()))) return null;
  }
  return matches[0];
}

export function contextualRequest(input: { reference: string; caseId: number; task: PilotTask; previous?: Observation; escalation?: boolean }): { subject: string; body: string } {
  const { task, previous } = input;
  const outstanding = task.expected.filter(v => !task.confirmed.includes(v));
  return {
    subject: `S${input.caseId} — ${input.escalation ? "Overdue: " : ""}${task.label} [${input.reference}]`,
    body: [
      `Case S${input.caseId}: ${task.label}.`,
      `Expected by ${task.dueAt}.`,
      task.notBeforeAt ? `Do not remove access before ${task.notBeforeAt}.` : "",
      task.confirmed.length ? `Recorded portions: ${task.confirmed.join(", ")}.` : "No completed portions recorded.",
      `Outstanding: ${outstanding.join(", ")}.`,
      previous ? `Recorded response: ${previous.explanation}` : "",
      previous?.question || (task.id === "shared-accounts" ? `Who will take ownership of the shared account, and when will reassignment be confirmed? Include Shared account owner: <current member id>. Your enrolled source member reference is ${task.owner ?? "not assigned"}.` : task.id === "kt-access-exception" ? `Is temporary KT access required? Include KT required: no, or KT required: yes plus KT owner: <current member id>, KT expiry: <future ISO timestamp> and KT authorization: <reviewed reference>, each on its own line. Your enrolled source member reference is ${task.owner ?? "not assigned"}.` : "Please provide each outstanding result, source reference and any delay or exception."),
      input.escalation ? "Please coordinate with the accountable owner. This escalation is not completion evidence." : "",
      input.previous && task.status === "resolved" ? "" : `For an unambiguous source attestation, reply with one line: I confirm ${input.reference}: ${outstanding.join(", ")}`,
      "Only confirm portions you have checked. An acknowledgment, send acceptance or request for review does not confirm completion.",
      "These accounts and assets belong to the fictional case. Email records do not certify real account disablement or physical return.",
      `Reference: ${input.reference}`,
    ].filter(Boolean).join("\n\n"),
  };
}
