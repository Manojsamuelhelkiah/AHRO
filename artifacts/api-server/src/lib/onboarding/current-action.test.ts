import assert from "node:assert/strict";
import { test } from "node:test";
import { currentActionForCase, openCaseAssignments, readableCurrentAction, type ActionLedgerEntry } from "./current-action";

const stream = (key: string, status: string) => ({ key, label: `${key} work`, status });
const row = { lifecycleStage: "preboarding", orchestrationStatus: "running", workstreams: [
  stream("ready", "ready"), stream("queued", "pending"), stream("active", "in-progress"), stream("held", "blocked"),
] };
const ledger = (id: number, kind: string, body = {}, owner = "HR"): ActionLedgerEntry =>
  ({ id, caseId: 1, kind, status: "open", owner, assignee: null, payload: { body } });

test("current work is deterministic, source-backed and independent of original intent", () => {
  const before = JSON.stringify(row);
  assert.deepEqual(currentActionForCase(row), {
    key: "workstream:held", label: "held work", status: "blocked", source: "workstream", additionalCount: 2,
  });
  assert.equal(JSON.stringify(row), before);
  assert.equal(currentActionForCase({ ...row, workstreams: row.workstreams.slice(0, 3) })?.key, "workstream:active");
});

test("unknown, ready and terminal states do not manufacture current work", () => {
  assert.equal(currentActionForCase({ workstreams: [] }), null);
  assert.equal(currentActionForCase({ workstreams: [stream("x", "ready"), stream("y", "unknown")] }), null);
  assert.equal(currentActionForCase({ ...row, lifecycleStage: "complete" }, [ledger(5, "assign")]), null);
  assert.equal(currentActionForCase({ ...row, orchestrationStatus: "done" }), null);
  assert.equal(currentActionForCase({ ...row, hireType: "separation" }), null);
});

test("resolution and reassignment select the newest still-open assignment without mutating history", () => {
  const rows = [ledger(1, "assign"), ledger(2, "escalate"), ledger(3, "reassign", { workItemId: 1 }, "Payroll"),
    ledger(4, "resolve", { workItemId: 2 })];
  const before = JSON.stringify(rows);
  const open = openCaseAssignments(rows);
  assert.equal(open.length, 1);
  assert.equal(open[0].owner, "Payroll");
  assert.equal(open[0].id, 1);
  assert.equal(JSON.stringify(rows), before);
  assert.deepEqual(currentActionForCase(row, open), {
    key: "human-review", label: "Assigned human review", source: "action-center", status: "pending", additionalCount: 0,
  });
});

test("newest open escalation is prioritized and resolved work cannot return", () => {
  const assignments = openCaseAssignments([ledger(1, "assign"), ledger(2, "escalate")]);
  assert.equal(currentActionForCase(row, assignments)?.key, "human-escalation");
  assert.equal(currentActionForCase(row, assignments)?.additionalCount, 1);
  assert.equal(openCaseAssignments([ledger(1, "assign"), ledger(2, "resolve", { workItemId: 1 })]).length, 0);
});

test("current action disclosure requires field access and never turns illustrative work into live workload", () => {
  const action = currentActionForCase(row);
  const access = { opaqueRead: true, readinessRead: true, illustrative: false };
  assert.deepEqual(readableCurrentAction(action, access), action);
  assert.equal(readableCurrentAction(action, { ...access, opaqueRead: false }), null);
  assert.equal(readableCurrentAction(action, { ...access, readinessRead: false }), null);
  assert.equal(readableCurrentAction(action, { ...access, illustrative: true }), null);
  const review = currentActionForCase(row, [ledger(1, "assign")]);
  assert.deepEqual(readableCurrentAction(review, { ...access, readinessRead: false }), review);
});
