import assert from "node:assert/strict";
import { reconcileDevelopmentDatabase } from "../../api-server/test-db-setup.mjs";

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
const pageUrl = new URL("/cost-explorer/intents", baseUrl);
const apiUrl = new URL("/api/intents", pageUrl);
const browserHeaders = {
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "same-origin",
};

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
    ...browserHeaders,
    accept: "application/json",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
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

const rollupUrl = new URL("/api/rollup", baseUrl);
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
  `Intent and rollup smoke passed: schema is compatible, ${pageUrl.pathname} loaded, and estimate generation succeeded through ${baseUrl.origin}`,
);