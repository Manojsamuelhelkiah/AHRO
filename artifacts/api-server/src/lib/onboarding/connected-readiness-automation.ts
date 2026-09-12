import { runReadinessSlaTick } from "./readiness-sla-worker";
import { runApprovalNotificationsTick } from "./approval-decisions";
import { makeSharedTick } from "./shared-tick";
import { logger } from "../logger";
import { runAuditAnchorTick } from "./external-audit-anchor";

// The heartbeat awaits the same in-flight run as the local timer. This keeps
// autoscale from freezing a still-running outbox after an early response.
export const runConnectedReadinessTick = makeSharedTick(async () => {
  await runAuditAnchorTick();
  await runReadinessSlaTick();
  await runApprovalNotificationsTick();
});

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