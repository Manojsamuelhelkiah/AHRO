import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ensureDevelopmentSmokeMembership,
  reconcileDevelopmentDatabase,
} from "../../api-server/test-db-setup.mjs";
import {
  createDependencyOrchestrator,
  DEFAULT_SMOKE_WEB_URL,
  DEFAULT_SMOKE_API_URL,
} from "./smoke-dependencies.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const startupTimeoutMs = Number(
  process.env.INTENT_ROUTING_SMOKE_STARTUP_TIMEOUT_MS ?? 60_000,
);
const probeTimeoutMs = 2_500;
const retryDelayMs = 500;

if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
  throw new Error(
    "INTENT_ROUTING_SMOKE_STARTUP_TIMEOUT_MS must be a positive number.",
  );
}

const rawBaseUrl =
  process.env.INTENT_ROUTING_SMOKE_BASE_URL ??
  (process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : undefined);

if (!rawBaseUrl) {
  throw new Error(
    "Set INTENT_ROUTING_SMOKE_BASE_URL or run inside Replit with REPLIT_DEV_DOMAIN.",
  );
}

const baseUrl = new URL(rawBaseUrl);
const browserHeaders = {
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "same-origin",
};
const apiProbeHeaders = {
  accept: "application/json",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

async function probe(url, expectedContentType, headers = browserHeaders) {
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    return (
      response.ok &&
      (response.headers.get("content-type") ?? "").includes(expectedContentType)
    );
  } catch {
    return false;
  }
}

const { waitForDependency, stopSpawnedDependencies } =
  createDependencyOrchestrator({
    workspaceRoot,
    startupTimeoutMs,
    probe,
    retryDelayMs,
  });

process.once("exit", stopSpawnedDependencies);
process.once("SIGINT", () => {
  stopSpawnedDependencies();
  process.exit(130);
});
process.once("SIGTERM", () => {
  stopSpawnedDependencies();
  process.exit(143);
});

const remotePageUrl = new URL("/cost-explorer/intents", baseUrl);
const localPageUrl = new URL(
  "/cost-explorer/intents",
  process.env.INTENT_ROUTING_SMOKE_WEB_URL ?? DEFAULT_SMOKE_WEB_URL,
);
const remoteHealthUrl = new URL("/api/healthz", baseUrl);
const localHealthUrl = new URL(
  "/api/healthz",
  process.env.INTENT_ROUTING_SMOKE_API_URL ?? DEFAULT_SMOKE_API_URL,
);
const localWebPort = localPageUrl.port || "80";
const localApiPort = localHealthUrl.port || "80";

const [pageUrl, healthUrl] = await Promise.all([
  waitForDependency({
    name: "Cost Explorer",
    urls: [remotePageUrl, localPageUrl],
    expectedContentType: "text/html",
    remoteHeaders: browserHeaders,
    start: {
      name: "Cost Explorer",
      command: ["--filter", "@workspace/cost-explorer", "run", "dev"],
      env: { PORT: localWebPort, BASE_PATH: "/cost-explorer/" },
    },
  }),
  waitForDependency({
    name: "API server",
    urls: [remoteHealthUrl, localHealthUrl],
    expectedContentType: "application/json",
    remoteHeaders: apiProbeHeaders,
    localHeaders: apiProbeHeaders,
    start: {
      name: "API server",
      command: ["--filter", "@workspace/api-server", "run", "dev"],
      env: { PORT: localApiPort, API_VALIDATION_MODE: "true" },
    },
  }),
]);

const apiUrl = new URL("/api/intents", healthUrl);

await reconcileDevelopmentDatabase();
const smokeIdentity = await ensureDevelopmentSmokeMembership();
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  throw new Error("SESSION_SECRET is required to authenticate the smoke requests");
}

function authenticatedHeaders(url, method = "GET") {
  const timestamp = Date.now().toString();
  const key = createHmac("sha256", sessionSecret)
    .update("api-internal-smoke-auth:v1")
    .digest();
  const signature = createHmac("sha256", key)
    .update(
      [
        method.toUpperCase(),
        url.pathname,
        timestamp,
        smokeIdentity.userId,
      ].join("\n"),
    )
    .digest("hex");
  return {
    "x-organization-id": smokeIdentity.organizationId,
    "x-internal-smoke-user-id": smokeIdentity.userId,
    "x-internal-smoke-timestamp": timestamp,
    "x-internal-smoke-signature": signature,
  };
}

const pageResponse = await fetch(pageUrl, { headers: browserHeaders });
assert.equal(
  pageResponse.ok,
  true,
  `Intent Corpus page returned ${pageResponse.status} at ${pageUrl}`,
);
assert.match(
  pageResponse.headers.get("content-type") ?? "",
  /text\/html/i,
  `Expected the Intent Corpus route to return the web app HTML at ${pageUrl}`,
);

const apiResponse = await fetch(apiUrl, {
  headers: {
    ...apiProbeHeaders,
    accept: "application/json",
    ...authenticatedHeaders(apiUrl),
  },
});
const contentType = apiResponse.headers.get("content-type") ?? "";
const body = await apiResponse.text();

assert.equal(
  apiResponse.ok,
  true,
  `/api/intents returned ${apiResponse.status} through ${baseUrl.origin}`,
);
assert.match(
  contentType,
  /application\/json/i,
  `/api/intents returned ${contentType || "no content type"} instead of JSON. Body starts: ${body.slice(0, 120)}`,
);
assert.doesNotMatch(
  body,
  /^\s*<!doctype html/i,
  "/api/intents was captured by the web app HTML fallback",
);

const payload = JSON.parse(body);
assert.equal(
  Array.isArray(payload.intents),
  true,
  "/api/intents JSON did not contain an intents array",
);

const rollupUrl = new URL("/api/rollup", healthUrl);
const rollupResponse = await fetch(rollupUrl, {
  method: "POST",
  headers: {
    accept: "application/json",
    "content-type": "application/json",
    ...authenticatedHeaders(rollupUrl, "POST"),
  },
  body: JSON.stringify({
    inputs: {
      numSystems: 4,
      annualTransactions: 120000,
      employees: 8000,
      sector: "manufacturing",
      companyType: "multi-country",
      isolationTier: "siloed",
      hrHourlyCostUsd: 38,
      hitlHourlyCostUsd: 42,
      countries: 6,
    },
  }),
});
const rollupBody = await rollupResponse.text();
assert.equal(
  rollupResponse.ok,
  true,
  `/api/rollup returned ${rollupResponse.status}; schema reconciliation or estimate generation failed. Body starts: ${rollupBody.slice(0, 240)}`,
);
const rollup = JSON.parse(rollupBody);
assert.equal(
  Array.isArray(rollup.rows),
  true,
  "/api/rollup JSON did not contain estimate rows",
);

console.log(
  `Intent and rollup smoke passed: schema is compatible, ${pageUrl.pathname} loaded, and estimate generation succeeded through ${healthUrl.origin}`,
);
stopSpawnedDependencies();