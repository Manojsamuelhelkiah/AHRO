import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_TYPES, caseTypeOf } from "../pages/cases/case-presentation";
import { actionCenterTypeFromSearch, actionCenterTypeHref, actionConversationHref } from "./action-center-filter";

test("all supported Cases families round-trip through URL state; All and invalid values are unfiltered", () => {
  for (const type of CASE_TYPES.slice(1)) {
    const href = actionCenterTypeHref("/approvals", "tab=communications", type);
    assert.equal(actionCenterTypeFromSearch(href.split("?")[1]!), type);
  }
  assert.equal(actionCenterTypeFromSearch(""), undefined);
  assert.equal(actionCenterTypeFromSearch("caseType=unknown"), undefined);
  assert.equal(actionCenterTypeFromSearch("caseType=All+Cases"), undefined);
  assert.equal(caseTypeOf({ hireType: "separation" }), "Offboarding");
});
test("changing or clearing case type preserves every existing deep-link and fragment", () => {
  const source = "tab=conversation&caseId=41&workItemId=9&approvalId=2&approvalRef=Gate+A";
  const selected = actionCenterTypeHref("/approvals", source, "Offboarding", "#review");
  const params = new URLSearchParams(selected.split("?")[1]!.split("#")[0]);
  for (const [key, value] of new URLSearchParams(source)) assert.equal(params.get(key), value);
  assert.equal(params.get("caseType"), "Offboarding");
  assert.ok(selected.endsWith("#review"));
  assert.equal(actionCenterTypeHref("/approvals", params.toString()), `/approvals?${source}`);
});
test("conversation navigation keeps the selected family and never silently changes an explicit case", () => {
  const source = "caseType=Offboarding&tab=needs-attention&caseId=20&workItemId=3";
  const href = actionCenterTypeHref("/approvals", source, "Payroll");
  const next = new URLSearchParams(href.split("?")[1]);
  assert.equal(next.get("caseId"), "20"); assert.equal(next.get("workItemId"), "3");
  const opened = new URLSearchParams(actionConversationHref(source, 42, 8).split("?")[1]);
  assert.equal(opened.get("caseType"), "Offboarding");
  assert.equal(opened.get("caseId"), "42"); assert.equal(opened.get("workItemId"), "8");
  assert.equal(new URLSearchParams(actionConversationHref(source, 42).split("?")[1]).has("workItemId"), false);
});
