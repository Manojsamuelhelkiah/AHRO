import { and, eq, inArray, desc } from "drizzle-orm";
import { db, onbCases, offbExchanges } from "@workspace/db";
import { separationListSnapshot, separationDetail } from "./service";
import { confidentialRead } from "./authority";
import { SeparationError } from "./model";
import { matchesActionCenterContext } from "../onboarding/action-center-family";

/** Read-only adapter: summary existence is never a pending or completed action. */
export async function separationActionCenter(org: string, actor: string, filters: {
  caseType?: string; workforce?: string; safetyCritical?: boolean; siteExposure?: boolean; scope?: string;
}) {
  try { return await separationActionCenterSnapshot(org, actor, filters); }
  catch (e) { if (e instanceof SeparationError) throw e;
    throw new SeparationError("Offboarding source could not be loaded.", 503); }
}
async function separationActionCenterSnapshot(org: string, actor: string, filters: {
  caseType?: string; workforce?: string; safetyCritical?: boolean; siteExposure?: boolean; scope?: string;
}) {
  const caseSummaries: Array<{
    caseId: number; caseType: string; label: string; status: string; caseHref: string;
  }> = [];
  const domainRecords: Array<{
    id: string; caseId: number; category: "attention" | "communication" | "completed" | "activity";
    title: string; detail: string; status: string; caseHref: string;
    createdAt?: string | null; actor?: string | null; owner?: string | null; dueAt?: string | null;
  }> = [];
  if (filters.caseType && filters.caseType !== "Offboarding") return { caseSummaries, domainRecords, offboardingSource: "available" as const };
  const snapshot = await separationListSnapshot(org, actor);
  const summaries = snapshot.visible;
  const envelopes = summaries.length ? await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, org), inArray(onbCases.id, summaries.map(s => s.id)),
  )) : [];
  const byId = new Map(envelopes.map(e => [e.id, e]));
  for (const s of summaries) {
    const envelope = byId.get(s.id);
    if (!envelope || !matchesActionCenterContext(envelope, filters)) continue;
    const caseHref = `/cases/separations/${s.id}`;
    caseSummaries.push({ caseId: s.id, caseType: "Offboarding",
      label: s.fictionalOfflineIdentity ? `S${s.id}` : `Case #${s.id}`, status: s.status, caseHref });
    const detail = await separationDetail(org, actor, s.id);
    for (const task of detail.state.tasks) {
      const completed = task.status === "verified";
      if (!completed && ["cancelled", "transfer-review"].includes(s.status)) continue;
      domainRecords.push({ id: `separation-task:${s.id}:${task.id}`, caseId: s.id,
        category: completed ? "completed" : "attention",
        title: detail.privateVisible ? task.label : "Offboarding task", detail: `Recorded task state: ${task.status}.`,
        status: task.status, caseHref, owner: detail.privateVisible ? task.owner : null, dueAt: task.dueAt,
        createdAt: task.evidence?.recordedAt ?? null, actor: null });
    }
    for (const checkpoint of detail.history.slice(0, 20)) {
      domainRecords.push({ id: `separation-history:${s.id}:${checkpoint.version}`, caseId: s.id,
        category: "activity", title: "Offboarding action recorded",
        detail: `Recorded action: ${checkpoint.action}. State: ${checkpoint.status}.`,
        status: "recorded", caseHref, createdAt: checkpoint.recordedAt.toISOString(),
        actor: checkpoint.actor });
    }
    // Exchange metadata is a separate domain source, not onboarding delivery
    // history. Do not read its payload without its existing disclosure gate.
    const exchanges = await db.transaction(async tx => {
      try { await confidentialRead(tx, org, actor, undefined, s.id); }
      catch (e) { if (e instanceof SeparationError && e.status === 403) return []; throw e; }
      return tx.select({ id: offbExchanges.id, kind: offbExchanges.kind, status: offbExchanges.status,
        direction: offbExchanges.direction, createdAt: offbExchanges.createdAt }).from(offbExchanges).where(and(
        eq(offbExchanges.organizationId, org), eq(offbExchanges.caseId, s.id),
      )).orderBy(desc(offbExchanges.createdAt));
    });
    for (const message of exchanges) {
      if (message.direction === "interface") continue;
      domainRecords.push({ id: `separation-exchange:${message.id}`, caseId: s.id,
        category: "communication", title: "Offboarding communication",
        detail: `Recorded ${message.direction} ${message.kind} state: ${message.status}.`,
        status: message.status, caseHref, createdAt: message.createdAt.toISOString(), actor: null });
    }
  }
  return { caseSummaries, domainRecords: domainRecords.filter(r =>
    filters.scope === "completed" ? r.category === "completed" :
      filters.scope === "active" ? r.category !== "completed" : true),
    offboardingSource: snapshot.sourceState };
}
