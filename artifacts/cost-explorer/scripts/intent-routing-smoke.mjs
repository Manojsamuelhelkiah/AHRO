import assert from "node:assert/strict";

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

console.log(
  `Intent routing smoke passed: ${pageUrl.pathname} loaded and ${apiUrl.pathname} returned JSON through ${baseUrl.origin}`,
);