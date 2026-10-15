import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { CaseActionBlock } from "./case-action-block";
import { CaseAccessProvider, type CaseAccessPermissions } from "./case-access";

const permissions: CaseAccessPermissions = {
  caseId: 41, access: { flowRead: true, flowEdit: false, profileRead: true, profileEdit: false,
    notesRead: true, notesEdit: false },
  sensitive: { identity: { read: true, edit: false }, medical: { read: true, edit: false },
    payroll: { read: true, edit: false }, bgv: { read: true, edit: false } },
};
function render(status: string, blockers: string[] = []) {
  const c = { id: 41, caseFamily: "Payroll", hireType: "external", orchestrationStatus: "idle",
    readiness: [], workstreams: [{ key: "payroll", label: "Payroll review", status, blockers }] };
  return renderToStaticMarkup(<Router ssrPath="/cases/41"><CaseAccessProvider value={permissions}>
    <CaseActionBlock c={c} caseId={41} pendingApprovals={[]} setTab={() => {}} offlineSample={false} />
  </CaseAccessProvider></Router>);
}
test("non-Onboarding pending workstreams remain visible without approvals or blocker text", () => {
  const html = render("pending");
  assert.match(html, /Review 1 pending workstream/);
  assert.match(html, /Payroll review/);
  assert.match(html, /Pending current evidence, decisions and executable dependencies/);
  assert.doesNotMatch(html, /No decision or checklist item needs you now/);
});
test("completed workstreams do not fabricate pending actions", () => {
  const html = render("completed");
  assert.match(html, /No decision or checklist item needs you now/);
  assert.doesNotMatch(html, /Payroll review|pending workstream/);
});
test("blocked workstream wording stays visible with the existing case controls", () => {
  const html = render("blocked", ["Recorded dependency pending"]);
  assert.match(html, /Resolve the blockers shown here/);
  assert.match(html, /Recorded dependency pending/);
});
