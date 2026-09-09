import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { reconcileDevelopmentDatabase } from "../../api-server/test-db-setup.mjs";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const startupTimeoutMs = Number(
  process.env.INTENT_ROUTING_SMOKE_STARTUP_TIMEOUT_MS ?? 60_000,
);
const probeTimeoutMs = 2_500;
const retryDelayMs = 500;
const spawnedDependencies = [];

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function startDependency({ name, command, env }) {
  const output = [];
  let spawnError;
  const child = spawn("pnpm", command, {
    cwd: workspaceRoot,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const rememberOutput = (chunk) => {
    output.push(chunk.toString());
    if (output.join("").length > 8_000) output.shift();
  };
  child.stdout.on("data", rememberOutput);
  child.stderr.on("data", rememberOutput);
  child.on("error", (error) => {
    spawnError = error;
  });

  const dependency = {
    name,
    child,
    output,
    get spawnError() {
      return spawnError;
    },
  };
  spawnedDependencies.push(dependency);
  return dependency;
}

async function waitForDependency({
  name,
  urls,
  expectedContentType,
  start,
  remoteHeaders = browserHeaders,
  localHeaders,
}) {
  for (const url of urls) {
    const headers =
      url.origin === urls.at(-1).origin ? localHeaders : remoteHeaders;
    if (await probe(url, expectedContentType, headers)) {
      console.log(`Reusing running ${name} at ${url.origin}`);
      return url;
    }
  }

  const dependency = startDependency(start);
  const deadline = Date.now() + startupTimeoutMs;
  const localUrl = urls.at(-1);

  while (Date.now() < deadline) {
    if (dependency.spawnError) {
      throw new Error(
        `Could not start ${name}: ${dependency.spawnError.message}`,
      );
    }
    if (dependency.child.exitCode !== null) {
      throw new Error(
        `${name} exited with code ${dependency.child.exitCode} before becoming ready at ${localUrl}.\n${dependency.output.join("").slice(-4_000)}`,
      );
    }
    if (await probe(localUrl, expectedContentType, localHeaders)) {
      console.log(`Started ${name} at ${localUrl.origin}`);
      return localUrl;
    }
    await delay(retryDelayMs);
  }

  throw new Error(
    `Timed out after ${startupTimeoutMs}ms waiting for ${name} at ${localUrl}.\n${dependency.output.join("").slice(-4_000)}`,
  );
}

function stopSpawnedDependencies() {
  for (const { child } of spawnedDependencies) {
    if (child.exitCode !== null) continue;
    try {
      if (process.platform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

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
  process.env.INTENT_ROUTING_SMOKE_WEB_URL ?? "http://127.0.0.1:18940",
);
const remoteHealthUrl = new URL("/api/healthz", baseUrl);
const localHealthUrl = new URL(
  "/api/healthz",
  process.env.INTENT_ROUTING_SMOKE_API_URL ?? "http://127.0.0.1:8080",
);
const localWebPort = localPageUrl.port || "80";
const localApiPort = localHealthUrl.port || "80";

const [pageUrl, healthUrl] = await Promise.all([
  waitForDependency({
    name: "Cost Explorer",
    urls: [remotePageUrl, localPageUrl],
    expectedContentType: "text/html",
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