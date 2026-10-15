import app from "./app";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import { logger } from "./lib/logger";
import { startInboundEmailPolling } from "./lib/onboarding/inbound-email";
import { startSystemWatcher } from "./lib/onboarding/system-watcher";
import { startEmailWatch } from "./lib/onboarding/email-watch";
import { backfillDocumentPacks } from "./lib/onboarding/documents";
import { initDemoAllowlist } from "./lib/onboarding/recipient-allowlist";
import { recoverStaleVoiceSessions } from "./lib/onboarding/voice";
import { startApproverInboxPolling } from "./lib/onboarding/approver-email";
import { startConnectedReadinessAutomation } from "./lib/onboarding/connected-readiness-automation";
import { db, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { verifyProtectedAudit } from "./lib/onboarding/protected-audit";
import { enforceRegulatedProductionStartupGuard } from "./lib/regulated-production-startup-guard";
import { startSensitiveLifecycleDeletionWorker } from "./lib/onboarding/sensitive-lifecycle";
import { initializeExecutableFlows } from "./lib/flow-manager/manager";

const rawPort = process.env["PORT"];
const validationMode = process.env["API_VALIDATION_MODE"] === "true";

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

await enforceRegulatedProductionStartupGuard(process.env, {
  organizationExists: async (organizationId) => {
    const [organization] = await db
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId))
      .limit(1);
    return organization !== undefined;
  },
  verifyProtectedAudit,
});

// Metadata only. Existing domain workers are not started until immutable
// definitions and conservative compatibility identities have been checked.
if (!validationMode) await initializeExecutableFlows();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, validationMode }, "Server listening");

  if (validationMode) {
    logger.info("Validation mode enabled; background automations are disabled");
    return;
  }

  startInboundEmailPolling();
  startSystemWatcher();
  startEmailWatch();
  startApproverInboxPolling();
  startConnectedReadinessAutomation();
  startSensitiveLifecycleDeletionWorker();
  backfillDocumentPacks().catch((err) =>
    logger.error({ err }, "document pack backfill failed"),
  );
  initDemoAllowlist(DEMO_ORGANIZATION_ID).catch((err) =>
    logger.error({ err }, "demo allowlist init failed"),
  );
  recoverStaleVoiceSessions()
    .then((n) => {
      if (n > 0) logger.info({ recovered: n }, "finalized interrupted voice calls");
    })
    .catch((err) => logger.error({ err }, "voice session recovery failed"));
});
