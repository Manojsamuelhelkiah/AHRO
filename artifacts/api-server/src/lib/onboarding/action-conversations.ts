import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { actionConversationMessages as messages, db, onbActionCenterActions } from "@workspace/db";
import { PostActionConversationBody, PostActionConversationResponse, GetActionConversationResponse, ExplainOnboardingCaseResponse } from "@workspace/api-zod";
import { resolveEffectiveAccess, resolveEffectiveAccessInTransaction } from "../access-governance";
import { registeredDemoProfile } from "../demo-principal";
import { hasOpaqueNarrativeAccess, resolveSensitiveAccess, resolveSensitiveAccessInTransaction, ALL_SENSITIVE_RECORD_CLASSES, withSensitiveAuthorityFence } from "./sensitive-access";
import { assertCaseDerivedLifecycleWriteAllowedInTransaction, evaluateSensitiveLifecycleGate, jurisdictionForCaseDerivedEnvelope, OPAQUE_CANDIDATE_UPLOAD_CLASSES, withSensitiveLifecycleFence } from "./sensitive-lifecycle";
import { collectCaseExplainabilityEvidence, findExplainableCase } from "./case-explainability-evidence";
import { caseAnalysisRestriction } from "./case-analysis-eligibility";
import { isSeparationOrLegacyExit } from "./separation-isolation";
import { defaultCompletion, explainCase, ExplainabilityUnavailableError, type ExplainabilityCompletion } from "./case-explainability";
import { MAX_COMPLETION_TOKENS } from "./case-explainability-completion";
import { checkHroAiBudget } from "../hro-context/ai-budget";
import { conversationAgents } from "./action-conversation-agents";
import { CONVERSATION_NOTICE, conversationDigest, conversationEvidenceFingerprint, conversationIntent, interruptedConversationState, resolveConversationMention } from "./action-conversation-contract";

type Row = typeof messages.$inferSelect;
type Input = ReturnType<typeof PostActionConversationBody.parse>;
export class ConversationError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const deny = (status: number, message: string): never => { throw new ConversationError(status, message); };
const scope = (organizationId: string, caseId: number) => and(eq(messages.organizationId, organizationId), eq(messages.caseId, caseId));

export async function conversationAccess(organizationId: string, actor: string, caseId: number, write = false) {
  const row = await findExplainableCase(organizationId, caseId);
  if (!row) return deny(404, "Case not found.");
  const access = await resolveEffectiveAccess({ organizationId, principalType: "human", principalId: actor, caseId, purpose: "action-conversation" });
  if (!["flow.case.read", "data.case.notes.read"].every(key => access.allows.includes(key)) ||
    !hasOpaqueNarrativeAccess(await resolveSensitiveAccess({ organizationId, caseId, actorUserId: actor }))) {
    return deny(403, "Current case, notes and all sensitive-content read permissions are required. Conversation content is withheld.");
  }
  // Opaque chat is a governed derivative of every applicable data class.
  for (const dataClass of OPAQUE_CANDIDATE_UPLOAD_CLASSES) {
    const gate = await evaluateSensitiveLifecycleGate({ organizationId, jurisdiction: jurisdictionForCaseDerivedEnvelope(row), dataClass, disclosure: false, collection: false, purpose: "record-access" });
    if (!gate.allowed) return deny(403, "Conversation records are unavailable under the current record lifecycle policy.");
  }
  const canPost = !await registeredDemoProfile(actor) &&
    ["data.case.notes.edit", "flow.case.edit"].every(key => access.allows.includes(key)) &&
    ALL_SENSITIVE_RECORD_CLASSES.every(key => access.allows.includes(`data.${key}.edit`));
  if (write && !canPost) return deny(403, "Current named-user case, notes and sensitive-content edit permissions are required. Public Demo grants no conversation-writing authority.");
  return { row, access, canPost };
}

async function validateWork(organizationId: string, caseId: number, workItemId?: number) {
  if (workItemId === undefined) return;
  if (!Number.isSafeInteger(workItemId) || workItemId < 1) return deny(400, "A valid work item is required.");
  const [item] = await db.select({ id: onbActionCenterActions.id }).from(onbActionCenterActions).where(and(
    eq(onbActionCenterActions.organizationId, organizationId), eq(onbActionCenterActions.caseId, caseId),
    eq(onbActionCenterActions.id, workItemId),
    sql`${onbActionCenterActions.kind} in ('assign','reassign','escalate')`,
  ));
  if (!item) deny(404, "Work item not found in this case.");
}

/** All mutation boundaries use the existing lifecycle and tenant authority
 * fences, sharing the same transaction rather than nesting pooled writers. */
async function writeConversation<T>(organizationId: string, actor: string, caseId: number, write: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  return withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
    organizationId, caseId, actorUserId: actor, classification: "identity",
    additionalClassifications: ["medical", "payroll", "bgv"],
    additionalAccessKeys: ["flow.case.read", "flow.case.edit", "data.case.notes.read", "data.case.notes.edit"],
    mutateInTransaction: async tx => {
      await assertCaseDerivedLifecycleWriteAllowedInTransaction(tx, { organizationId, caseId });
      const sensitive = await resolveSensitiveAccessInTransaction(tx, { organizationId, caseId, actorUserId: actor });
      const access = await resolveEffectiveAccessInTransaction(tx, { organizationId, principalType: "human", principalId: actor, caseId, purpose: "action-conversation-write" });
      if (!hasOpaqueNarrativeAccess(sensitive) || !access.allows.includes("flow.case.read")) return deny(403, "Conversation access changed.");
      return write(tx);
    },
  }));
}

async function currentEvidence(organizationId: string, actor: string, caseId: number) {
  const { row, access } = await conversationAccess(organizationId, actor, caseId);
  const restriction = await caseAnalysisRestriction(row);
  if (restriction) return deny(403, restriction);
  // Current adapters cover onboarding only; service requests and separation
  // must not be described using an onboarding projection.
  if (isSeparationOrLegacyExit(row) || row.hireType === "service-request") {
    return deny(403, "Read-only evidence triage is unavailable for this case family. Review its existing case controls.");
  }
  const projection = access.allows.includes("data.case.profile.read") ? row : { ...row, joiningDate: "Restricted" };
  const evidence = await collectCaseExplainabilityEvidence(organizationId, caseId, projection);
  if (!evidence || evidence.truncated) return deny(409, "Required grounding exceeds the supported evidence window. Review case records directly; no partial answer was generated.");
  return { row: projection, evidence, fingerprint: conversationEvidenceFingerprint(evidence), caseFingerprint: conversationDigest(projection) };
}

async function disclose(organizationId: string, actor: string, caseId: number, row: Row) {
  await conversationAccess(organizationId, actor, caseId);
  let visible = { ...row, state: interruptedConversationState(row) };
  // Historical AI text is not a standing disclosure receipt. If policy,
  // evidence or registration changed, do not reveal its saved response.
  if (row.explanation || (row.agentKey && row.reply)) {
    try {
      const evidence = row.explanation ? await currentEvidence(organizationId, actor, caseId) : null;
      const selected = row.agentKey ? (await conversationAgents(organizationId, actor, caseId)).find(agent => agent.key === row.agentKey) : null;
      if ((evidence && evidence.fingerprint !== row.evidenceFingerprint) ||
        (row.agentKey && (!selected?.eligible || selected.fingerprint !== row.agentFingerprint))) throw new Error("changed");
      if (row.explanation) {
        const access = await resolveEffectiveAccess({ organizationId, principalType: "human", principalId: actor, caseId, purpose: "action-conversation-ai-disclosure" });
        if (!access.allows.includes("tool.external.dispatch")) throw new Error("changed");
        // Re-evaluate actual provider disclosure without making a request.
        const { assertConversationProviderDisclosure } = await import("./action-conversation-provider");
        await assertConversationProviderDisclosure(evidence!.row);
      }
    } catch {
      visible = { ...visible, state: "withheld", reply: "Saved AI response withheld: current evidence, agent eligibility or disclosure permission changed. Review permitted case records.", explanation: null, reviewHref: null };
    }
  }
  const state = visible.state;
  if (state === "uncertain") visible.reply = "The response was interrupted or its provider outcome is uncertain. This submission will not be dispatched again automatically.";
  await conversationAccess(organizationId, actor, caseId);
  return PostActionConversationResponse.parse(visible);
}

export async function getConversation(organizationId: string, actor: string, caseId: number, before?: number, workItemId?: number) {
  await conversationAccess(organizationId, actor, caseId);
  await validateWork(organizationId, caseId, workItemId);
  const rows = await db.select().from(messages).where(and(scope(organizationId, caseId),
    before ? lt(messages.id, before) : undefined,
    workItemId ? eq(messages.workItemId, workItemId) : isNull(messages.workItemId),
  )).orderBy(desc(messages.id)).limit(31);
  const page = rows.slice(0, 30);
  const output = [];
  for (const row of page.reverse()) output.push(await disclose(organizationId, actor, caseId, row));
  const agents = await conversationAgents(organizationId, actor, caseId);
  const access = await conversationAccess(organizationId, actor, caseId);
  return GetActionConversationResponse.parse({ organizationId, caseId, messages: output,
    nextBefore: rows.length > 30 ? Math.min(...page.map(row => row.id)) : null,
    agents, canPost: access.canPost, notice: CONVERSATION_NOTICE });
}

export async function postConversation(organizationId: string, actor: string, caseId: number, input: Input, complete?: ExplainabilityCompletion) {
  await conversationAccess(organizationId, actor, caseId, true);
  await validateWork(organizationId, caseId, input.workItemId);
  if (!input.text.trim()) return deny(400, "Enter a message.");
  const digest = conversationDigest([caseId, input.workItemId ?? null, input.mode, input.text, input.agentKey ?? null]);
  // Insert and reserve quota atomically. A duplicate can only read this row;
  // neither pending nor failed attempts are ever reclaimed for dispatch.
  const claim = await writeConversation(organizationId, actor, caseId, async tx => {
    const [prior] = await tx.select().from(messages).where(and(eq(messages.organizationId, organizationId), eq(messages.author, actor), eq(messages.submissionId, input.submissionId)));
    if (prior) {
      if (prior.requestDigest !== digest) return deny(409, "Submission identifier belongs to different content.");
      return { row: prior, claimed: false };
    }
    if (input.mode === "triage") {
      const [inFlight] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(
        eq(messages.organizationId, organizationId), eq(messages.author, actor), eq(messages.state, "pending"),
        gt(messages.updatedAt, new Date(Date.now() - 120_000)),
      ));
      if ((inFlight?.n ?? 0) >= 2) return deny(429, "Two triage responses are already pending. Use note-only mode or review their status.");
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(
        eq(messages.organizationId, organizationId), eq(messages.author, actor), eq(messages.mode, "triage"),
        gt(messages.createdAt, new Date(Date.now() - 60_000)),
      ));
      if ((count?.n ?? 0) >= 10) return deny(429, "Read-only triage budget reached. Use note-only mode or try later.");
    }
    const [row] = await tx.insert(messages).values({
      organizationId, caseId, workItemId: input.workItemId ?? null, submissionId: input.submissionId,
      requestDigest: digest, author: actor, text: input.text, mode: input.mode,
      agentKey: input.mode === "triage" ? input.agentKey ?? null : null, state: input.mode === "note" ? "recorded" : "pending",
    }).returning();
    return { row: row!, claimed: input.mode === "triage" };
  });
  if (!claim.claimed) return disclose(organizationId, actor, caseId, claim.row);
  let result: Partial<Row> = {};
  let dispatchStarted = false;
  try {
    const selected = resolveConversationMention(input.text, input.agentKey);
    if (selected.error) {
      result = { state: "completed", outcome: "unavailable", reply: selected.error, agentKey: null };
    } else {
      const agent = selected.key ? (await conversationAgents(organizationId, actor, caseId)).find(row => row.key === selected.key) : null;
      if (selected.key && !agent?.eligible) {
        result = { state: "completed", outcome: "unavailable", reply: "Selected agent is unregistered, ambiguous, private or unavailable under your current owner and case grants. No agent was invoked.", agentKey: null };
      } else {
        const grounding = await currentEvidence(organizationId, actor, caseId);
        const active = await conversationAccess(organizationId, actor, caseId, true);
        if (!active.access.allows.includes("tool.external.dispatch")) return deny(403, "AI triage requires your own current external-provider spending permission. Selecting an agent cannot grant it.");
        const assertCurrent = async () => {
          const current = await currentEvidence(organizationId, actor, caseId);
          const auth = await conversationAccess(organizationId, actor, caseId, true);
          if (!auth.access.allows.includes("tool.external.dispatch") || current.fingerprint !== grounding.fingerprint || current.caseFingerprint !== grounding.caseFingerprint) return deny(409, "Case access or evidence changed during analysis.");
          if (agent) {
            const latest = (await conversationAgents(organizationId, actor, caseId)).find(row => row.key === agent.key);
            if (!latest?.eligible || latest.fingerprint !== agent.fingerprint) return deny(403, "Selected agent eligibility changed.");
          }
        };
        // Clarification continuity is resolved locally from the immediately
        // preceding durable turn, not client-supplied or truncated chat.
        // Arbitrary annotations are never sent as provider-bound history.
        const [preceding] = await db.select().from(messages).where(and(
          scope(organizationId, caseId), lt(messages.id, claim.row.id),
          input.workItemId ? eq(messages.workItemId, input.workItemId) : isNull(messages.workItemId),
        )).orderBy(desc(messages.id)).limit(1);
        const triageText = preceding?.outcome === "clarification"
          ? `${preceding.text}\n${input.text}` : input.text;
        const answer = ExplainOnboardingCaseResponse.parse(await explainCase(grounding.row, triageText, undefined, grounding.evidence, async (...args) => {
          await assertCurrent();
          // Prove local budget failures before recording an ambiguous attempt.
          checkHroAiBudget([{ content: args[0] }, { content: args[1] }], MAX_COMPLETION_TOKENS);
          if (!dispatchStarted) {
            await writeConversation(organizationId, actor, caseId, async tx => {
              const updated = await tx.update(messages).set({ dispatchStartedAt: new Date(), updatedAt: new Date() }).where(and(
                eq(messages.id, claim.row.id), eq(messages.state, "pending"), isNull(messages.dispatchStartedAt),
              )).returning();
              if (!updated.length) return deny(409, "This provider attempt is already owned and cannot be replayed.");
            });
            dispatchStarted = true;
          }
          // Serialize the final model call with grant/session mutations as
          // well as lifecycle/provider policy changes. Selection never
          // supplies the initiator's spending or sensitive-record authority.
          return withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
            organizationId, caseId, actorUserId: actor, classification: "identity",
            additionalClassifications: ["medical", "payroll", "bgv"],
            additionalAccessKeys: ["flow.case.read", "data.case.notes.read", "data.case.notes.edit", "tool.external.dispatch"],
            mutate: () => (complete ?? defaultCompletion(grounding.row))(...args),
          }));
        }));
        await assertCurrent();
        const intent = preceding?.outcome === "clarification" && conversationIntent(input.text) === "answer"
          ? "proposal" : conversationIntent(input.text);
        result = {
          state: "completed", outcome: intent, explanation: answer,
          evidenceFingerprint: grounding.fingerprint,
          agentKey: agent?.key ?? null, agentFingerprint: agent?.fingerprint ?? null,
          reply: intent === "clarification" ? "Which equipment item and expected arrival date are you referring to? Your statement is an annotation, not delivery evidence. Review the cited records before proposing a follow-up. Nothing has been sent to IT."
            : intent === "proposal" ? "Proposed next step — not executed: review the cited case records in the existing case controls. Any action still requires its own current permissions, confirmation and approvals."
              : "Read-only AI answer based on the cited records. Current policy does not establish missing historical rationale.",
          reviewHref: `/cases/${caseId}`,
        };
      }
    }
  } catch (error) {
    const denied = error instanceof ConversationError || error instanceof ExplainabilityUnavailableError &&
      /denied|blocked|^HRO_AI_/.test(error.metadata?.code ?? "");
    result = { state: denied ? "failed" : dispatchStarted ? "uncertain" : "failed", outcome: "unavailable",
      reply: error instanceof ConversationError ? error.message : denied
        ? "AI triage is unavailable under current provider, sensitive-content or model policy. Review permitted case records."
        : "AI response unavailable. This submission will not be replayed; no operational action was executed.",
      explanation: null, reviewHref: null };
  }
  const saved = await writeConversation(organizationId, actor, caseId, async tx => {
    const [row] = await tx.update(messages).set({ ...result, updatedAt: new Date(), version: 2 }).where(and(eq(messages.id, claim.row.id), eq(messages.state, "pending"))).returning();
    return row ?? claim.row;
  });
  return disclose(organizationId, actor, caseId, saved);
}
