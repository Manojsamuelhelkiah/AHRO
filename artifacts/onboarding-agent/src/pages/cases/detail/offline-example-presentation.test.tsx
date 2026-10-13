import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AttentionPanel } from "./overview";
import { CaseHealthStrip, CaseTabs, CaseHeader, OriginalIntent } from "./components";
import { CaseAccessProvider, type CaseAccessPermissions } from "./case-access";

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

test("original intent is readable without hover and does not infer a missing or restricted origin", () => {
  for (const [value, expected] of [["Application access request", "Application access request"], [undefined, "Not recorded"], [null, "Restricted"]] as const) {
    const html = renderToStaticMarkup(<OriginalIntent c={{ originalIntent: value }} />);
    assert.match(html, /Original intent:/);
    assert.ok(html.includes(expected));
    assert.doesNotMatch(html, /title=/);
    assert.match(html, /break-words/);
  }
});

test("detail header orders reference, original intent, scenario title and family", () => {
  const access: CaseAccessPermissions = {
    caseId: 9001, access: { flowRead: true, profileRead: true, profileEdit: false,
      notesRead: true, notesEdit: false, flowEdit: false },
    sensitive: { identity: { read: false, edit: false }, medical: { read: false, edit: false },
      payroll: { read: false, edit: false }, bgv: { read: false, edit: false } },
  };
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <CaseAccessProvider value={access}>
    <CaseHeader c={{
      id: 9001, originalIntent: "Application access request", requestType: "Application jurisdiction inquiry",
      caseFamily: "IT Access", fictionalOfflineIdentity: true, offlineSample: true,
      workerName: "Example — Kiran Oak", orchestrationStatus: "blocked", lifecycleStage: "service-intake",
      role: "Analyst", geography: "India", joiningDate: "2030-11-14",
    }} caseId={9001} />
    </CaseAccessProvider>
  </QueryClientProvider>);
  assert.ok(html.indexOf("S9001") < html.indexOf("Original intent:"));
  assert.ok(html.indexOf("Original intent:") < html.indexOf("Application jurisdiction inquiry"));
  assert.ok(html.indexOf("Application jurisdiction inquiry") < html.indexOf("IT Access"));
  assert.doesNotMatch(html, /Take Action|Contact<\/button>/);
});
