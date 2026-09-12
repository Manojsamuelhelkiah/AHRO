import { runReadinessSlaTick } from "./readiness-sla-worker";
import { runApprovalNotificationsTick } from "./approval-decisions";
import { makeSharedTick } from "./shared-tick";
import { logger } from "../logger";
import { runAuditAnchorTick } from "./external-audit-anchor";
import { runExternalAuditAnchorReviewerAlertTick } from "./external-audit-anchor-alerts";
import { runEarlyTenureReminderTick } from "./early-tenure";

export async function runConnectedReadinessWorkers(workers: {
  auditAnchor?: () => Promise<unknown>;
  auditReviewerAlert?: () => Promise<unknown>;
  readinessSla?: () => Promise<unknown>;
  earlyTenure?: () => Promise<unknown>;
  approvalNotifications?: () => Promise<unknown>;
} = {}): Promise<void> {
  const auditAnchor = workers.auditAnchor ?? runAuditAnchorTick;
  const auditReviewerAlert = workers.auditReviewerAlert ?? runExternalAuditAnchorReviewerAlertTick;
  const readinessSla = workers.readinessSla ?? runReadinessSlaTick;
  const earlyTenure = workers.earlyTenure ?? runEarlyTenureReminderTick;
  const approvalNotifications = workers.approvalNotifications ?? runApprovalNotificationsTick;
  // Keep the audit reviewer alert ordered after its anchor, but run every
  // independent heartbeat worker to completion even when a legacy row breaks
  // another worker. The shared tick still awaits all promises, so autoscale
  // does not observe an early successful heartbeat.
  const results = await Promise.allSettled([
    (async () => {
      await auditAnchor();
      await auditReviewerAlert();
    })(),
    readinessSla(),
    earlyTenure(),
    approvalNotifications(),
  ]);
  const names = ["audit-anchor/reviewer-alert", "readiness-sla", "early-tenure-reminders", "approval-notifications"];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logger.error({ err: result.reason, worker: names[index] }, "Connected readiness worker failed; independent ticks completed");
    }
  }
  const failures = results
    .map((result, index) => result.status === "rejected"
      ? new Error(`${names[index]} failed`, { cause: result.reason })
      : null)
    .filter((error): error is Error => error !== null);
  if (failures.length) throw new AggregateError(failures, "One or more connected readiness workers failed.");
}

// The heartbeat awaits the same in-flight run as the local timer. This keeps
// autoscale from freezing a still-running outbox after an early response.
export const runConnectedReadinessTick = makeSharedTick(runConnectedReadinessWorkers);

let timer: ReturnType<typeof setInterval> | undefined;
export function startConnectedReadinessAutomation() {
  if (timer) return;
  const tick = () => {
    void runConnectedReadinessTick().catch((err) =>
      logger.error({ err }, "Connected readiness automation failed"),
    );
  };
  timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
}