import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AttentionPanel } from "./overview";
import { CaseHealthStrip, CaseTabs } from "./components";

test("offline decision summary does not claim active execution or approval authority", () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <AttentionPanel caseId={1} offlineSample approval={undefined} />
    </QueryClientProvider>,
  );
  assert.match(html, /No live decisions/);
  assert.match(html, /no execution or approval authority/);
  assert.doesNotMatch(html, /Automated execution is proceeding|<button/);
});

test("read-only health cards and tabs retain accessible narrow-screen layouts", () => {
  const health = renderToStaticMarkup(<CaseHealthStrip c={{
    lifecycleStage: "service-intake", orchestrationStatus: "blocked",
    workstreams: [{ status: "pending" }],
  }} pendingApprovals={[]} offlineSample />);
  assert.match(health, /execution is intentionally disabled/);
  assert.match(health, /grid-cols-2 xl:grid-cols-4/);
  assert.doesNotMatch(health, /Automated execution active/);
  const tabs = renderToStaticMarkup(<CaseTabs activeTab="Overview" setTab={() => {}} offlineSample />);
  assert.match(tabs, /flex-wrap/);
  assert.doesNotMatch(tabs, /overflow-x-auto/);
});
