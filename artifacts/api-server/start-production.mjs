import { pathToFileURL } from "node:url";
import { verifyTenantSafeguards } from "./verify-tenant-safeguards.mjs";

const DEFAULT_ALERT_TIMEOUT_MS = 5_000;

async function defaultAlertBlockedPublish() {
  const { alertBlockedPublish } = await import("./publish-safeguard-alert.mjs");
  return alertBlockedPublish();
}

async function defaultClearBlockedPublishAlert() {
  const { clearBlockedPublishAlert } = await import(
    "./publish-safeguard-alert.mjs"
  );
  return clearBlockedPublishAlert();
}

async function runAlertWorkWithDeadline(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function startProduction({
  verify = verifyTenantSafeguards,
  alertBlockedPublish = defaultAlertBlockedPublish,
  clearBlockedPublishAlert = defaultClearBlockedPublishAlert,
  alertTimeoutMs = DEFAULT_ALERT_TIMEOUT_MS,
  startApi = () => import("./dist/index.mjs"),
} = {}) {
  console.log(
    "Verifying tenant safeguards against the published production database...",
  );
  let result;
  try {
    result = await verify();
  } catch (error) {
    await runAlertWorkWithDeadline(
      alertBlockedPublish,
      alertTimeoutMs,
      "blocked-publish operator alert",
    ).catch((alertError) => {
      console.error(`Blocked-publish operator alert failed: ${alertError.message}`);
    });
    throw error;
  }

  if (result.failures.length > 0) {
    const details = result.failures.map((failure) => `- ${failure}`).join("\n");
    await runAlertWorkWithDeadline(
      alertBlockedPublish,
      alertTimeoutMs,
      "blocked-publish operator alert",
    ).catch((alertError) => {
      console.error(`Blocked-publish operator alert failed: ${alertError.message}`);
    });
    throw new Error(
      `Tenant safeguard verification failed for schema ${result.schema}. ` +
        "Production is not trusted and the API will not start.\n" +
        details,
    );
  }

  console.log(
    `Tenant safeguard verification passed for schema ${result.schema}. ` +
      "Production is trusted; starting the API.",
  );
  await runAlertWorkWithDeadline(
    clearBlockedPublishAlert,
    alertTimeoutMs,
    "blocked-publish alert reset",
  ).catch((error) => {
    console.error(`Blocked-publish alert reset failed: ${error.message}`);
  });
  await startApi();
}

export async function runProductionCli({
  start = startProduction,
  exit = (code) => process.exit(code),
} = {}) {
  try {
    await start();
  } catch (error) {
    console.error(`Production startup blocked: ${error.message}`);
    exit(1);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void runProductionCli();
}