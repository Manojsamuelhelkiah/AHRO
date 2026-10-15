import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import type { OnbActionCenter } from "@workspace/api-client-react";
import { ActionCaseSummaries, DomainRecords, ActionCasePresentation, ActionReference } from "./action-center-domain-records";
const data = {
  caseSummaries: [{ caseId: 41, caseType: "Offboarding", label: "S41", status: "held",
    caseHref: "/cases/separations/41" }],
  domainRecords: [],
} as unknown as OnbActionCenter;
test("summary-only separations are distinct from all three record categories and use the existing detail route", () => {
  const html = renderToStaticMarkup(<Router ssrPath="/approvals"><ActionCaseSummaries data={data} /></Router>);
  assert.match(html, /Case summaries \(1\)/);
  assert.match(html, /not counted as pending actions, completions or sent messages/);
  assert.match(html, /href="\/cases\/separations\/41"/);
  assert.match(html, /S41/); assert.doesNotMatch(html, /Case #41/);
  for (const category of ["attention", "communication", "completed"] as const) {
    assert.equal(renderToStaticMarkup(<DomainRecords data={data} category={category} />), "");
  }
});
test("recorded requests remain communications, never successful sends or task completions", () => {
  const snapshot = { ...data, domainRecords: [{ id: "request:1", caseId: 41, category: "communication" as const,
    title: "Offboarding communication", detail: "Recorded outbound request state: queued.", status: "queued",
    caseHref: "/cases/separations/41" }] };
  const html = renderToStaticMarkup(<Router ssrPath="/approvals"><DomainRecords data={snapshot} category="communication" /></Router>);
  assert.match(html, /queued/); assert.doesNotMatch(html, /Sent|Completed/);
  assert.equal(renderToStaticMarkup(<DomainRecords data={snapshot} category="completed" />), "");
});
test("case-linked sample references stay S-number-only with the common family label", () => {
  const html = renderToStaticMarkup(<ActionCasePresentation.Provider value={data.caseSummaries!}>
    <ActionReference caseId={41} />
  </ActionCasePresentation.Provider>);
  assert.match(html, /S41/); assert.match(html, /Offboarding/); assert.doesNotMatch(html, /Case #/);
});
