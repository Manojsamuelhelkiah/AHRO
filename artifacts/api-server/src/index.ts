import app from "./app";
import { logger } from "./lib/logger";
import { startInboundEmailPolling } from "./lib/onboarding/inbound-email";
import { startSystemWatcher } from "./lib/onboarding/system-watcher";
import { startEmailWatch } from "./lib/onboarding/email-watch";
import { backfillDocumentPacks } from "./lib/onboarding/documents";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startInboundEmailPolling();
  startSystemWatcher();
  startEmailWatch();
  backfillDocumentPacks().catch((err) =>
    logger.error({ err }, "document pack backfill failed"),
  );
});
