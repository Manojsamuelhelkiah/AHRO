import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntentCorpusAvailability, IntentCorpusStatus } from "./intent-corpus-status";

function render(props: Partial<React.ComponentProps<typeof IntentCorpusStatus>> = {}) {
  return renderToStaticMarkup(
    <IntentCorpusStatus
      isLoading={false}
      isError={false}
      error={null}
      isFetching={false}
      onRetry={() => undefined}
      loading={<p>Loading corpus…</p>}
      {...props}
    >
      <p>No intents found matching your criteria.</p>
    </IntentCorpusStatus>,
  );
}

test("loading is distinct from an empty successful search", () => {
  const html = render({ isLoading: true });
  assert.match(html, /Loading corpus/);
  assert.doesNotMatch(html, /No intents found/);
});

test("request errors show a retryable error instead of an empty state", () => {
  const html = render({ isError: true, error: new Error("HTTP 503 Service Unavailable") });
  assert.match(html, /Intent Corpus could not be loaded/);
  assert.match(html, /HTTP 503 Service Unavailable/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /No intents found/);
});

test("a successful empty search retains the no-results message", () => {
  const html = render();
  assert.match(html, /No intents found matching your criteria/);
  assert.doesNotMatch(html, /could not be loaded/);
});

test("degraded corpus consumers warn that custom intents are unavailable", () => {
  const html = renderToStaticMarkup(
    <IntentCorpusAvailability
      isError={false}
      error={null}
      customIntentsAvailable={false}
      warning="Reference intents only."
      unavailableActions="Calculations are paused until intent data recovers."
      isFetching={false}
      onRetry={() => undefined}
    />,
  );
  assert.match(html, /Custom intents are temporarily unavailable/);
  assert.match(html, /Reference intents only/);
  assert.match(html, /Calculations are paused/);
  assert.match(html, /Retry/);
});

test("healthy corpus consumers render no warning", () => {
  const html = renderToStaticMarkup(
    <IntentCorpusAvailability
      isError={false}
      error={null}
      customIntentsAvailable
      isFetching={false}
      onRetry={() => undefined}
    />,
  );
  assert.equal(html, "");
});