import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { DEMO_ORGANIZATION_ID, onbEvents, onbSettings } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import { cleanupCandidateAccess } from "./candidate-portal";
import { sendAdministrativeAlertEmail } from "./inbound-email";
import { HR_ALERT_EMAIL_KEY } from "./settings";

export const CANDIDATE_CLEANUP_TELEMETRY_KEY = "candidate_access_cleanup_telemetry";
export const CANDIDATE_CLEANUP_FAILURE_ALERT_THRESHOLD = 3;
export const CANDIDATE_CLEANUP_DELAY_MS = 5 * 60_000;
export const CANDIDATE_CLEANUP_ALERT_CLAIM_MS = 2 * 60_000;

export type CandidateCleanupAlertDelivery = {
  outageDeliveredAt: string | null;
  recoveryDeliveredAt: string | null;
  claimKind: "outage" | "recovery" | null;
  claimToken: string | null;
  claimExpiresAt: string | null;
};

export type CandidateCleanupAlertEpisode = {
  recoveredAt: string | null;
  deliveries: Record<string, CandidateCleanupAlertDelivery>;
};

export type CandidateCleanupTelemetry = {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  expiredSessions: number;
  retainedLinksDeleted: number;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorAt: string | null;
  /** The actively failing cleanup episode, separate from older pending recoveries. */
  outageStartedAt: string | null;
  alertEpisodes: Record<string, CandidateCleanupAlertEpisode>;
  /** Compatibility summary; true when every currently targeted outage alert was delivered. */
  alerted: boolean;
};

export type CandidateCleanupHealth = {
  state: "healthy" | "delayed" | "failed";
  healthy: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  expiredSessions: number;
  retainedLinksDeleted: number;
  consecutiveFailures: number;
  lastErrorAt: string | null;
};

const EMPTY_TELEMETRY: CandidateCleanupTelemetry = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  expiredSessions: 0,
  retainedLinksDeleted: 0,
  consecutiveFailures: 0,
  lastError: null,
  lastErrorAt: null,
  outageStartedAt: null,
  alertEpisodes: {},
  alerted: false,
};

function validInstant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function parseAlertDeliveries(value: unknown): Record<string, CandidateCleanupAlertDelivery> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([organizationId, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const delivery = raw as Partial<CandidateCleanupAlertDelivery>;
      return [[organizationId, {
        outageDeliveredAt: validInstant(delivery.outageDeliveredAt),
        recoveryDeliveredAt: validInstant(delivery.recoveryDeliveredAt),
        claimKind: delivery.claimKind === "outage" || delivery.claimKind === "recovery"
          ? delivery.claimKind
          : null,
        claimToken: typeof delivery.claimToken === "string" ? delivery.claimToken : null,
        claimExpiresAt: validInstant(delivery.claimExpiresAt),
      } satisfies CandidateCleanupAlertDelivery]];
    }),
  );
}

export function parseCandidateCleanupTelemetry(value: string | null): CandidateCleanupTelemetry {
  if (!value) return { ...EMPTY_TELEMETRY };
  try {
    const parsed = JSON.parse(value) as Partial<CandidateCleanupTelemetry> & {
      alertDeliveries?: Record<string, CandidateCleanupAlertDelivery>;
    };
    const outageStartedAt = validInstant(parsed.outageStartedAt);
    const alertEpisodes = Object.fromEntries(
      Object.entries(parsed.alertEpisodes ?? {}).flatMap(([episodeId, raw]) => {
        if (!raw || typeof raw !== "object") return [];
        const episode = raw as Partial<CandidateCleanupAlertEpisode>;
        return [[episodeId, {
          recoveredAt: validInstant(episode.recoveredAt),
          deliveries: parseAlertDeliveries(episode.deliveries),
        } satisfies CandidateCleanupAlertEpisode]];
      }),
    );
    if (
      outageStartedAt
      && Object.keys(alertEpisodes).length === 0
      && parsed.alertDeliveries
    ) {
      alertEpisodes[outageStartedAt] = {
        recoveredAt: (parsed.consecutiveFailures ?? 0) === 0
          ? validInstant(parsed.lastSuccessAt)
          : null,
        deliveries: parseAlertDeliveries(parsed.alertDeliveries),
      };
    }
    return {
      lastAttemptAt: validInstant(parsed.lastAttemptAt),
      lastSuccessAt: validInstant(parsed.lastSuccessAt),
      expiredSessions: Number.isInteger(parsed.expiredSessions) && (parsed.expiredSessions ?? 0) >= 0 ? parsed.expiredSessions! : 0,
      retainedLinksDeleted: Number.isInteger(parsed.retainedLinksDeleted) && (parsed.retainedLinksDeleted ?? 0) >= 0 ? parsed.retainedLinksDeleted! : 0,
      consecutiveFailures: Number.isInteger(parsed.consecutiveFailures) && (parsed.consecutiveFailures ?? 0) >= 0 ? parsed.consecutiveFailures! : 0,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
      lastErrorAt: validInstant(parsed.lastErrorAt),
      outageStartedAt,
      alertEpisodes,
      alerted: parsed.alerted === true,
    };
  } catch {
    return { ...EMPTY_TELEMETRY };
  }
}

export function recordCandidateCleanupSuccess(
  current: CandidateCleanupTelemetry,
  attemptedAt: string,
  counts: { expiredSessions: number; retainedLinksDeleted: number },
): CandidateCleanupTelemetry {
  const alertEpisodes = { ...current.alertEpisodes };
  if (current.outageStartedAt) {
    const currentEpisode = alertEpisodes[current.outageStartedAt] ?? {
      recoveredAt: null,
      deliveries: {},
    };
    alertEpisodes[current.outageStartedAt] = {
      ...currentEpisode,
      recoveredAt: attemptedAt,
    };
  }
  return {
    ...current,
    lastAttemptAt: attemptedAt,
    lastSuccessAt: attemptedAt,
    expiredSessions: counts.expiredSessions,
    retainedLinksDeleted: counts.retainedLinksDeleted,
    consecutiveFailures: 0,
    lastError: null,
    outageStartedAt: null,
    alertEpisodes,
    alerted: false,
  };
}

export function recordCandidateCleanupFailure(
  current: CandidateCleanupTelemetry,
  attemptedAt: string,
  message: string,
): CandidateCleanupTelemetry {
  const consecutiveFailures = current.consecutiveFailures + 1;
  const sameOutage = current.consecutiveFailures > 0 && current.outageStartedAt !== null;
  const outageStartedAt = sameOutage ? current.outageStartedAt! : attemptedAt;
  const alertEpisodes = sameOutage
    ? current.alertEpisodes
    : {
        ...current.alertEpisodes,
        [outageStartedAt]: {
          recoveredAt: null,
          deliveries: {},
        },
      };
  return {
    ...current,
    lastAttemptAt: attemptedAt,
    consecutiveFailures,
    lastError: message,
    lastErrorAt: attemptedAt,
    outageStartedAt,
    alertEpisodes,
    alerted: sameOutage ? current.alerted : false,
  };
}

export function classifyCandidateCleanup(
  telemetry: CandidateCleanupTelemetry,
  now = Date.now(),
): CandidateCleanupHealth["state"] {
  if (telemetry.consecutiveFailures > 0) return "failed";
  const successAt = telemetry.lastSuccessAt ? Date.parse(telemetry.lastSuccessAt) : Number.NaN;
  if (!Number.isFinite(successAt) || now - successAt > CANDIDATE_CLEANUP_DELAY_MS) return "delayed";
  return "healthy";
}

export function candidateCleanupHealth(
  telemetry: CandidateCleanupTelemetry,
  now = Date.now(),
): CandidateCleanupHealth {
  const state = classifyCandidateCleanup(telemetry, now);
  return {
    state,
    healthy: state === "healthy",
    lastAttemptAt: telemetry.lastAttemptAt,
    lastSuccessAt: telemetry.lastSuccessAt,
    expiredSessions: telemetry.expiredSessions,
    retainedLinksDeleted: telemetry.retainedLinksDeleted,
    consecutiveFailures: telemetry.consecutiveFailures,
    lastErrorAt: telemetry.lastErrorAt,
  };
}

async function updateTelemetry(
  update: (current: CandidateCleanupTelemetry) => CandidateCleanupTelemetry,
): Promise<{ previous: CandidateCleanupTelemetry; next: CandidateCleanupTelemetry }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CANDIDATE_CLEANUP_TELEMETRY_KEY}))`);
    const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
      eq(onbSettings.key, CANDIDATE_CLEANUP_TELEMETRY_KEY),
    ));
    const previous = parseCandidateCleanupTelemetry(row?.value ?? null);
    const next = update(previous);
    await tx.insert(onbSettings).values({
      organizationId: DEMO_ORGANIZATION_ID,
      key: CANDIDATE_CLEANUP_TELEMETRY_KEY,
      value: JSON.stringify(next),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify(next), updatedAt: sql`now()` },
    });
    return { previous, next };
  });
}

async function recordTransition(
  organizationId: string,
  title: string,
  detail: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    await db.insert(onbEvents).values({
      organizationId,
      caseId: null,
      agent: "security-maintenance",
      engine: "system",
      hitlPattern: "notify-only",
      title,
      detail,
      idempotencyKey,
    }).onConflictDoNothing();
  } catch (error) {
    logger.error({ error: String(error) }, "[candidate-access-cleanup] failed to record alert transition");
  }
}

async function administrativeAlertOrganizations(): Promise<string[]> {
  const rows = await db.selectDistinct({ organizationId: onbSettings.organizationId })
    .from(onbSettings)
    .where(eq(onbSettings.key, HR_ALERT_EMAIL_KEY));
  return [...new Set([DEMO_ORGANIZATION_ID, ...rows.map((row) => row.organizationId)])];
}

type AlertKind = "outage" | "recovery";

async function sendCleanupAlert(
  organizationId: string,
  kind: AlertKind,
  outageStartedAt: string,
  at: string,
  failures: number,
): Promise<boolean> {
  const outageDetail = `Candidate-access cleanup failed ${failures} consecutive times. No candidate data is included. Outage began: ${outageStartedAt}.`;
  const recoveryDetail = `Candidate-access cleanup recovered at ${at}.`;
  const outage = kind === "outage";
  const title = outage ? "Candidate-access cleanup is failing" : "Candidate-access cleanup recovered";
  const detail = outage ? outageDetail : recoveryDetail;
  await recordTransition(
    organizationId,
    title,
    detail,
    `candidate-cleanup-${kind}:${outageStartedAt}`,
  );
  return sendAdministrativeAlertEmail(
    organizationId,
    outage
      ? "[Onboarding Control Tower] Candidate-access cleanup is failing"
      : "[Onboarding Control Tower] Candidate-access cleanup recovered",
    outage
      ? `${detail}\n\nExpired access records may accumulate until cleanup recovers. Settings will show the current maintenance status.`
      : detail,
  );
}

function blankDelivery(): CandidateCleanupAlertDelivery {
  return {
    outageDeliveredAt: null,
    recoveryDeliveredAt: null,
    claimKind: null,
    claimToken: null,
    claimExpiresAt: null,
  };
}

function episodeRecoveryIsComplete(
  episode: CandidateCleanupAlertEpisode,
  at: string,
): boolean {
  const now = Date.parse(at);
  return Object.values(episode.deliveries).every((delivery) => {
    const claimExpiresAt = delivery.claimExpiresAt
      ? Date.parse(delivery.claimExpiresAt)
      : Number.NaN;
    const hasActiveClaim = Boolean(delivery.claimToken) && (
      !Number.isFinite(claimExpiresAt)
      || claimExpiresAt > now
    );
    if (hasActiveClaim) return false;
    return !delivery.outageDeliveredAt || Boolean(delivery.recoveryDeliveredAt);
  });
}

async function claimAlertDelivery(
  organizationId: string,
  kind: AlertKind,
  outageStartedAt: string,
  now: Date,
  leaseMs: number,
): Promise<
  | { status: "claimed"; token: string }
  | { status: "complete" }
  | { status: "busy" }
> {
  const token = randomUUID();
  let result:
    | { status: "claimed"; token: string }
    | { status: "complete" }
    | { status: "busy" } = {
    status: "busy",
  };
  await updateTelemetry((current) => {
    const episode = current.alertEpisodes[outageStartedAt];
    if (!episode) {
      result = { status: "complete" };
      return current;
    }
    if (kind === "outage" && episode.recoveredAt) {
      result = { status: "complete" };
      return current;
    }
    if (kind === "recovery" && !episode.recoveredAt) {
      result = { status: "busy" };
      return current;
    }
    const delivery = episode.deliveries[organizationId] ?? blankDelivery();
    const claimExpiresAt = delivery.claimExpiresAt ? Date.parse(delivery.claimExpiresAt) : Number.NaN;
    if (delivery.claimToken && Number.isFinite(claimExpiresAt) && claimExpiresAt > now.getTime()) {
      result = { status: "busy" };
      return current;
    }
    if (
      (kind === "outage" && delivery.outageDeliveredAt)
      || (kind === "recovery" && (!delivery.outageDeliveredAt || delivery.recoveryDeliveredAt))
    ) {
      result = { status: "complete" };
      return current;
    }
    result = { status: "claimed", token };
    return {
      ...current,
      alertEpisodes: {
        ...current.alertEpisodes,
        [outageStartedAt]: {
          ...episode,
          deliveries: {
            ...episode.deliveries,
            [organizationId]: {
              ...delivery,
              claimKind: kind,
              claimToken: token,
              claimExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
            },
          },
        },
      },
    };
  });
  return result;
}

async function finishAlertDelivery(
  organizationId: string,
  kind: AlertKind,
  outageStartedAt: string,
  token: string,
  deliveredAt: string | null,
): Promise<void> {
  await updateTelemetry((current) => {
    const episode = current.alertEpisodes[outageStartedAt];
    if (!episode) return current;
    const delivery = episode.deliveries[organizationId];
    if (!delivery || delivery.claimToken !== token || delivery.claimKind !== kind) return current;
    return {
      ...current,
      alertEpisodes: {
        ...current.alertEpisodes,
        [outageStartedAt]: {
          ...episode,
          deliveries: {
            ...episode.deliveries,
            [organizationId]: {
              ...delivery,
              outageDeliveredAt: kind === "outage" && deliveredAt
                ? deliveredAt
                : delivery.outageDeliveredAt,
              recoveryDeliveredAt: kind === "recovery" && deliveredAt
                ? deliveredAt
                : delivery.recoveryDeliveredAt,
              claimKind: null,
              claimToken: null,
              claimExpiresAt: null,
            },
          },
        },
      },
    };
  });
}

async function deliverAlerts(
  organizationIds: string[],
  kind: AlertKind,
  outageStartedAt: string,
  at: string,
  failures: number,
  sendAlert: NonNullable<CandidateCleanupRunDeps["sendAlert"]>,
  leaseMs: number,
): Promise<boolean> {
  const results = await Promise.all([...new Set(organizationIds)].map(async (organizationId) => {
    const claim = await claimAlertDelivery(
      organizationId,
      kind,
      outageStartedAt,
      new Date(at),
      leaseMs,
    );
    if (claim.status === "complete") return true;
    if (claim.status === "busy") return false;
    let delivered = false;
    try {
      delivered = await sendAlert(organizationId, kind, outageStartedAt, at, failures);
    } catch (error) {
      logger.error({ error: String(error), organizationId, kind }, "[candidate-access-cleanup] alert delivery failed");
    }
    await finishAlertDelivery(
      organizationId,
      kind,
      outageStartedAt,
      claim.token,
      delivered ? at : null,
    );
    return delivered;
  }));
  return results.every(Boolean);
}

export type CandidateCleanupRunDeps = {
  cleanup?: typeof cleanupCandidateAccess;
  alertOrganizations?: () => Promise<string[]>;
  sendAlert?: (
    organizationId: string,
    kind: AlertKind,
    outageStartedAt: string,
    at: string,
    failures: number,
  ) => Promise<boolean>;
  alertClaimMs?: number;
  now?: () => Date;
};

export async function runCandidateAccessCleanup(
  deps: CandidateCleanupRunDeps = {},
): Promise<CandidateCleanupHealth> {
  const attemptedAt = (deps.now?.() ?? new Date()).toISOString();
  const cleanup = deps.cleanup ?? cleanupCandidateAccess;
  const listAlertOrganizations = deps.alertOrganizations ?? administrativeAlertOrganizations;
  const sendAlert = deps.sendAlert ?? sendCleanupAlert;
  const alertClaimMs = deps.alertClaimMs ?? CANDIDATE_CLEANUP_ALERT_CLAIM_MS;
  let counts: { expiredSessions: number; retainedLinksDeleted: number };
  try {
    counts = await cleanup();
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    const { previous, next } = await updateTelemetry((current) =>
      recordCandidateCleanupFailure(current, attemptedAt, message)
    );
    let final = next;
    if (
      next.consecutiveFailures >= CANDIDATE_CLEANUP_FAILURE_ALERT_THRESHOLD
      && next.outageStartedAt
    ) {
      const organizationIds = await listAlertOrganizations();
      const delivered = await deliverAlerts(
        organizationIds,
        "outage",
        next.outageStartedAt,
        attemptedAt,
        next.consecutiveFailures,
        sendAlert,
        alertClaimMs,
      );
      ({ next: final } = await updateTelemetry((current) => (
        current.outageStartedAt === next.outageStartedAt
          ? { ...current, alerted: delivered }
          : current
      )));
    }
    return candidateCleanupHealth(final);
  }

  const { next } = await updateTelemetry((current) =>
    recordCandidateCleanupSuccess(current, attemptedAt, counts)
  );
  const recoveries = Object.entries(next.alertEpisodes)
    .filter(([, episode]) => episode.recoveredAt);
  await Promise.all(recoveries.map(async ([episodeId, episode]) => {
    const delivered = await deliverAlerts(
      Object.keys(episode.deliveries),
      "recovery",
      episodeId,
      attemptedAt,
      0,
      sendAlert,
      alertClaimMs,
    );
    if (!delivered) return;
    await updateTelemetry((current) => {
      const currentEpisode = current.alertEpisodes[episodeId];
      if (!currentEpisode?.recoveredAt) return current;
      if (!episodeRecoveryIsComplete(currentEpisode, attemptedAt)) return current;
      const { [episodeId]: _completed, ...remainingEpisodes } = current.alertEpisodes;
      return { ...current, alertEpisodes: remainingEpisodes };
    });
  }));
  const { next: final } = await updateTelemetry((current) => current);
  return candidateCleanupHealth(final);
}

export async function getCandidateAccessCleanupHealth(now = Date.now()): Promise<CandidateCleanupHealth> {
  const [row] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, CANDIDATE_CLEANUP_TELEMETRY_KEY),
  ));
  return candidateCleanupHealth(parseCandidateCleanupTelemetry(row?.value ?? null), now);
}