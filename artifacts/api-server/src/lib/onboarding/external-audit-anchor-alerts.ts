import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, onbAuditAnchorOutbox, onbAuditHeads, onbSettings } from "@workspace/db";
import { sendEmail } from "./channels";
import { HR_ALERT_EMAIL_KEY, isValidEmail } from "./settings";
import {
  externalAuditAnchorReviewerFaults,
  externalAuditAnchorSafeStatus,
  type ExternalAuditAnchorReviewerFault,
  type ExternalAuditAnchorSafeStatus,
} from "./external-audit-anchor";
import { logger } from "../logger";

const KEY = "external_audit_anchor_reviewer_alert:";
const LOCK = "external-audit-anchor-reviewer-alert:";
export const EXTERNAL_AUDIT_ANCHOR_REVIEWER_ALERT_SUSTAINED_FAILURE_MS = 5 * 60_000;
export const EXTERNAL_AUDIT_ANCHOR_REVIEWER_ALERT_RETRY_MS = 60 * 60_000;
export const EXTERNAL_AUDIT_ANCHOR_REVIEWER_ALERT_CLAIM_ABANDON_AFTER_MS = 10 * 60_000;
const MAX_TERMINAL_RECOVERIES = 16;
type Delivery = "pending" | "sending" | "sent" | "failed" | "ambiguous";
type Notice = { state: Delivery; claimId: string | null; attemptId: string | null; attemptedAt: string | null; sentAt: string | null; retryAt: string | null };
type Episode = { id: string; startedAt: string; faults: ExternalAuditAnchorReviewerFault[]; notification: Notice };
type Recovery = { episodeId: string; incidentStartedAt: string; recoveredAt: string; outageNotification: Notice; notification: Notice };
type State = { version: 1; failureSince: string | null; activeEpisode: Episode | null; recoveries: Recovery[] };

export type ExternalAuditAnchorReviewerAlertStatus = {
  active: boolean;
  faults: ExternalAuditAnchorReviewerFault[];
  startedAt: string | null;
  notification: { state: Delivery | "none"; attemptedAt: string | null; sentAt: string | null; retryAt: string | null };
  lastRecovery: { recoveredAt: string | null; notification: Delivery | "none" };
};
export type ExternalAuditAnchorReviewerAlertDependencies = {
  assess?: (organizationId: string) => Promise<ExternalAuditAnchorSafeStatus>;
  send?: (organizationId: string, subject: string, body: string) => Promise<{ status: string; failureReason?: string | null }>;
  now?: () => Date; sustainedFailureMs?: number; notificationRetryMs?: number; stateKey?: string;
};
type Client = Pick<typeof db, "select" | "insert">;
const notice = (): Notice => ({ state: "pending", claimId: null, attemptId: null, attemptedAt: null, sentAt: null, retryAt: null });
const empty = (): State => ({ version: 1, failureSince: null, activeEpisode: null, recoveries: [] });
const date = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
const faults = (value: unknown): ExternalAuditAnchorReviewerFault[] =>
  Array.isArray(value) ? [...new Set(value.filter((x): x is ExternalAuditAnchorReviewerFault =>
    x === "delivery-backlog" || x === "provider-read-failed" || x === "receipt-verification-failed",
  ))].sort() : [];
const parseNotice = (value: unknown): Notice => {
  const x = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    state: ["sending", "sent", "failed", "ambiguous"].includes(String(x.state)) ? x.state as Delivery : "pending",
    claimId: typeof x.claimId === "string" ? x.claimId : null,
    attemptId: typeof x.attemptId === "string" ? x.attemptId : null,
    attemptedAt: date(x.attemptedAt), sentAt: date(x.sentAt), retryAt: date(x.retryAt),
  };
};
function unresolved(recovery: Recovery): boolean {
  return [recovery.outageNotification, recovery.notification].some((n) => n.state !== "sent");
}
/** Never drop failed, pending, in-flight, or ambiguous delivery obligations. */
function prune(state: State): void {
  const open = state.recoveries.filter(unresolved);
  const terminal = state.recoveries.filter((r) => !unresolved(r)).slice(-MAX_TERMINAL_RECOVERIES);
  state.recoveries = [...open, ...terminal].sort((a, b) => a.recoveredAt.localeCompare(b.recoveredAt));
}
function reconcileStaleClaims(state: State, now: Date): void {
  const reconcile = (n: Notice) => {
    if (n.state === "sending" && n.attemptedAt &&
      now.getTime() - new Date(n.attemptedAt).getTime() >= EXTERNAL_AUDIT_ANCHOR_REVIEWER_ALERT_CLAIM_ABANDON_AFTER_MS) {
      // The process may have died after Gmail accepted the request. Fence this
      // as uncertain rather than retrying a potentially delivered alert.
      n.state = "ambiguous"; n.claimId = null; n.retryAt = null;
    }
  };
  if (state.activeEpisode) reconcile(state.activeEpisode.notification);
  for (const recovery of state.recoveries) {
    reconcile(recovery.outageNotification); reconcile(recovery.notification);
  }
}
function parse(raw: string | null): State {
  if (!raw) return empty();
  try {
    const x = JSON.parse(raw) as Record<string, unknown>;
    if (x.version !== 1) return empty();
    const active = x.activeEpisode && typeof x.activeEpisode === "object" ? x.activeEpisode as Record<string, unknown> : null;
    const startedAt = date(active?.startedAt);
    const recoveries: Recovery[] = Array.isArray(x.recoveries) ? x.recoveries.flatMap((item) => {
      const r = item && typeof item === "object" ? item as Record<string, unknown> : null;
      const incidentStartedAt = date(r?.incidentStartedAt), recoveredAt = date(r?.recoveredAt);
      return r && typeof r.episodeId === "string" && incidentStartedAt && recoveredAt
        ? [{ episodeId: r.episodeId, incidentStartedAt, recoveredAt, outageNotification: parseNotice(r.outageNotification), notification: parseNotice(r.notification) }]
        : [];
    }) : [];
    const state: State = {
      version: 1, failureSince: date(x.failureSince),
      activeEpisode: active && typeof active.id === "string" && startedAt
        ? { id: active.id, startedAt, faults: faults(active.faults), notification: parseNotice(active.notification) } : null,
      recoveries,
    };
    prune(state);
    return state;
  } catch { return empty(); }
}
const stateKey = (deps: Pick<ExternalAuditAnchorReviewerAlertDependencies, "stateKey">) => deps.stateKey ?? KEY;
async function read(client: Client, organizationId: string, key: string): Promise<State> {
  const [row] = await client.select({ value: onbSettings.value }).from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key)));
  return parse(row?.value ?? null);
}
async function write(client: Client, organizationId: string, key: string, state: State): Promise<void> {
  await client.insert(onbSettings).values({ organizationId, key, value: JSON.stringify(state) }).onConflictDoUpdate({
    target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(state), updatedAt: sql`now()` },
  });
}
function apply(state: State, observed: ExternalAuditAnchorReviewerFault[], now: Date, sustained: number): void {
  if (observed.length) {
    state.failureSince ??= now.toISOString();
    if (!state.activeEpisode && now.getTime() - new Date(state.failureSince).getTime() >= sustained) {
      state.activeEpisode = { id: randomUUID(), startedAt: state.failureSince, faults: observed, notification: notice() };
    } else if (state.activeEpisode) state.activeEpisode.faults = faults([...state.activeEpisode.faults, ...observed]);
    return;
  }
  state.failureSince = null;
  if (!state.activeEpisode) return;
  const episode = state.activeEpisode;
  state.activeEpisode = null;
  state.recoveries.push({ episodeId: episode.id, incidentStartedAt: episode.startedAt, recoveredAt: now.toISOString(), outageNotification: episode.notification, notification: notice() });
  prune(state);
}
type Descriptor = { kind: "outage" | "recovery"; episodeId: string; claimId: string; faults: ExternalAuditAnchorReviewerFault[] };
function claim(state: State, now: Date): Descriptor | null {
  const can = (n: Notice) => n.state === "pending" || (n.state === "failed" && (!n.retryAt || new Date(n.retryAt).getTime() <= now.getTime()));
  const take = (n: Notice, kind: Descriptor["kind"], episodeId: string, incidentFaults: ExternalAuditAnchorReviewerFault[]) => {
    if (!can(n)) return null;
    n.state = "sending"; n.claimId = randomUUID(); n.attemptId = n.claimId; n.attemptedAt = now.toISOString(); n.retryAt = null;
    return { kind, episodeId, claimId: n.claimId, faults: incidentFaults };
  };
  if (state.activeEpisode) {
    const found = take(state.activeEpisode.notification, "outage", state.activeEpisode.id, state.activeEpisode.faults);
    if (found) return found;
  }
  for (const r of state.recoveries) {
    if (r.outageNotification.state === "pending" || r.outageNotification.state === "failed") {
      const found = take(r.outageNotification, "outage", r.episodeId, []);
      if (found) return found;
    }
    // An ambiguous outage is not retried, but a recovery can safely close an
    // alert that may already have reached its reviewer.
    if (r.outageNotification.state !== "sent" && r.outageNotification.state !== "ambiguous") continue;
    const found = take(r.notification, "recovery", r.episodeId, []);
    if (found) return found;
  }
  return null;
}
function message(kind: Descriptor["kind"], incidentFaults: readonly ExternalAuditAnchorReviewerFault[]) {
  return kind === "outage"
    ? { subject: "[Onboarding Control Tower] External audit anchor review required", body: `External audit anchoring requires reviewer attention.\n\nSafe status: ${incidentFaults.join(", ") || "anchor-monitor-failure"}.\n\nLocal append-only audit capture remains authoritative. Regulated production protection remains blocked until delivery and independent verification recover.` }
    : { subject: "[Onboarding Control Tower] External audit anchor monitoring recovered", body: "External audit anchor monitoring recovered from an earlier reviewer episode.\n\nSafe status: clear.\n\nThis closes the earlier episode. Local audit integrity must continue to be reviewed through the normal verification controls." };
}
async function configuredReviewer(organizationId: string): Promise<string | null> {
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, HR_ALERT_EMAIL_KEY)));
  const address = (row?.value ?? "").trim() || (process.env.HR_ALERT_EMAIL ?? process.env.ONBOARDING_HR_ALERT_EMAIL ?? "").trim();
  return isValidEmail(address) ? address : null;
}
async function deliver(organizationId: string, subject: string, body: string) {
  const to = await configuredReviewer(organizationId);
  return to ? sendEmail(to, subject, body) : { status: "failed" };
}
async function finalize(organizationId: string, d: Descriptor, result: { status: string; failureReason?: string | null } | null, now: Date, deps: ExternalAuditAnchorReviewerAlertDependencies): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${LOCK}${organizationId}`}))`);
    const state = await read(tx as unknown as Client, organizationId, stateKey(deps));
    const recovery = state.recoveries.find((r) => r.episodeId === d.episodeId);
    const n = d.kind === "outage" ? state.activeEpisode?.id === d.episodeId ? state.activeEpisode.notification : recovery?.outageNotification : recovery?.notification;
    if (!n || n.state !== "sending" || n.claimId !== d.claimId) return;
    n.claimId = null;
    if (result?.status === "sent") { n.state = "sent"; n.attemptId = null; n.sentAt = now.toISOString(); }
    else if (result?.status === "sending" || /outcome unknown|did not complete cleanly|ambiguous/i.test(result?.failureReason ?? "")) n.state = "ambiguous";
    else {
      n.state = "failed"; n.attemptId = null;
      n.retryAt = new Date(now.getTime() + (deps.notificationRetryMs ?? EXTERNAL_AUDIT_ANCHOR_REVIEWER_ALERT_RETRY_MS)).toISOString();
    }
    prune(state); await write(tx as unknown as Client, organizationId, stateKey(deps), state);
  });
}
/** Authenticated operators use this after provider-side reconciliation. No provider ids or message ids are accepted or returned. */
export async function reconcileExternalAuditAnchorReviewerAlert(
  organizationId: string,
  input: { episodeId: string; attemptId: string; kind: "outage" | "recovery"; outcome: "delivered" | "not-delivered" },
  deps: Pick<ExternalAuditAnchorReviewerAlertDependencies, "stateKey"> = {},
): Promise<"applied" | "not-found"> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${LOCK}${organizationId}`}))`);
    const state = await read(tx as unknown as Client, organizationId, stateKey(deps));
    reconcileStaleClaims(state, new Date());
    const episode = state.activeEpisode?.id === input.episodeId
      ? state.activeEpisode
      : state.recoveries.find((r) => r.episodeId === input.episodeId);
    const notification = !episode ? null
      : input.kind === "outage"
        ? ("outageNotification" in episode ? episode.outageNotification : episode.notification)
        : ("outageNotification" in episode ? episode.notification : null);
    // This exact opaque attempt token is a compare-and-set fence: an admin
    // cannot accidentally reconcile another episode or a later retry.
    if (!notification || notification.state !== "ambiguous" || notification.attemptId !== input.attemptId) return "not-found";
    notification.claimId = null;
    notification.attemptId = null;
    notification.retryAt = null;
    if (input.outcome === "delivered") {
      notification.state = "sent";
      notification.sentAt = new Date().toISOString();
    } else {
      notification.state = "failed";
      // The next heartbeat may make a fresh, explicitly reconciled attempt.
      notification.retryAt = new Date().toISOString();
    }
    prune(state);
    await write(tx as unknown as Client, organizationId, stateKey(deps), state);
    return "applied";
  });
}
export type ExternalAuditAnchorReviewerAmbiguousDelivery = {
  episodeId: string;
  attemptId: string;
  kind: "outage" | "recovery";
};
/** Safe authenticated-admin view: opaque workflow tokens only, never provider material. */
export async function getExternalAuditAnchorReviewerAmbiguousDeliveries(
  organizationId: string,
  deps: Pick<ExternalAuditAnchorReviewerAlertDependencies, "stateKey"> = {},
): Promise<ExternalAuditAnchorReviewerAmbiguousDelivery[]> {
  const state = await read(db, organizationId, stateKey(deps));
  const items: ExternalAuditAnchorReviewerAmbiguousDelivery[] = [];
  const add = (episodeId: string, kind: "outage" | "recovery", n: Notice) => {
    if (n.state === "ambiguous" && n.attemptId) items.push({ episodeId, attemptId: n.attemptId, kind });
  };
  if (state.activeEpisode) add(state.activeEpisode.id, "outage", state.activeEpisode.notification);
  for (const recovery of state.recoveries) {
    add(recovery.episodeId, "outage", recovery.outageNotification);
    add(recovery.episodeId, "recovery", recovery.notification);
  }
  return items;
}
export async function runExternalAuditAnchorReviewerAlertTickForOrganization(organizationId: string, deps: ExternalAuditAnchorReviewerAlertDependencies = {}): Promise<void> {
  const now = deps.now?.() ?? new Date(), status = await (deps.assess ?? externalAuditAnchorSafeStatus)(organizationId);
  const descriptor = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${LOCK}${organizationId}`}))`);
    const state = await read(tx as unknown as Client, organizationId, stateKey(deps));
    reconcileStaleClaims(state, now);
    apply(state, externalAuditAnchorReviewerFaults(status), now, deps.sustainedFailureMs ?? EXTERNAL_AUDIT_ANCHOR_REVIEWER_ALERT_SUSTAINED_FAILURE_MS);
    const claimed = claim(state, now); await write(tx as unknown as Client, organizationId, stateKey(deps), state); return claimed;
  });
  if (!descriptor) return;
  const alert = message(descriptor.kind, descriptor.faults);
  try { await finalize(organizationId, descriptor, await (deps.send ?? deliver)(organizationId, alert.subject, alert.body), now, deps); }
  catch { await finalize(organizationId, descriptor, null, now, deps); }
}
export async function runExternalAuditAnchorReviewerAlertTick(): Promise<void> {
  const [outbox, heads] = await Promise.all([db.selectDistinct({ organizationId: onbAuditAnchorOutbox.organizationId }).from(onbAuditAnchorOutbox), db.selectDistinct({ organizationId: onbAuditHeads.organizationId }).from(onbAuditHeads)]);
  for (const organizationId of new Set([...outbox, ...heads].map((x) => x.organizationId))) {
    await runExternalAuditAnchorReviewerAlertTickForOrganization(organizationId).catch(() => logger.error({ component: "external-audit-anchor-reviewer-alert" }, "external audit anchor reviewer alert tick failed"));
  }
}
export async function getExternalAuditAnchorReviewerAlertStatus(organizationId: string, deps: Pick<ExternalAuditAnchorReviewerAlertDependencies, "stateKey"> = {}): Promise<ExternalAuditAnchorReviewerAlertStatus> {
  const state = await read(db, organizationId, stateKey(deps)), n = state.activeEpisode?.notification, recovery = state.recoveries.at(-1);
  return { active: !!state.activeEpisode, faults: state.activeEpisode?.faults ?? [], startedAt: state.activeEpisode?.startedAt ?? null,
    notification: { state: n?.state ?? "none", attemptedAt: n?.attemptedAt ?? null, sentAt: n?.sentAt ?? null, retryAt: n?.retryAt ?? null },
    lastRecovery: {
      recoveredAt: recovery?.recoveredAt ?? null,
      notification: recovery?.outageNotification.state === "sent" || recovery?.outageNotification.state === "ambiguous"
        ? recovery.notification.state
        : "none",
    } };
}