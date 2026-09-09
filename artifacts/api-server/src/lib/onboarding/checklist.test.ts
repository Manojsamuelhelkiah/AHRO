import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_CHECKLIST,
  mandatoryChecklistReady,
  readinessFromChecklist,
  validateChecklist,
} from "./settings";
import { isChecklistAdministrator } from "./checklist";
import { checkpointSkipsPlanApproval } from "./engine";

describe("Day-1 checklist contract", () => {
  test("legacy compatibility supplies the ordered seven mandatory defaults", () => {
    assert.equal(LEGACY_CHECKLIST.length, 7);
    assert.deepEqual(LEGACY_CHECKLIST.map((item) => item.order), [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(LEGACY_CHECKLIST.every((item) => item.enabled && item.mandatory));
    assert.equal(validateChecklist([...LEGACY_CHECKLIST]), null);
  });

  test("validation rejects duplicate ids, duplicate/gapped order, and invalid stages", () => {
    const base = LEGACY_CHECKLIST[0];
    assert.match(validateChecklist([{ ...base }, { ...base, order: 1 }])!, /Duplicate checklist item id/);
    assert.match(validateChecklist([{ ...base, order: 1 }])!, /contiguous/);
    assert.match(
      validateChecklist([{ ...base, enforcementStage: "after-review" as typeof base.enforcementStage }])!,
      /invalid enforcement stage/,
    );
  });

  test("disabled items are omitted and optional items never block promotion", () => {
    const template = [
      { ...LEGACY_CHECKLIST[0], mandatory: false },
      { ...LEGACY_CHECKLIST[1], id: "optional-custom", order: 1, mandatory: false },
      { ...LEGACY_CHECKLIST[2], id: "disabled-custom", order: 2, enabled: false },
    ];
    const readiness = readinessFromChecklist(template);
    assert.deepEqual(readiness.map((item) => item.key), ["profile", "optional-custom"]);
    assert.equal(mandatoryChecklistReady({ checklistSnapshot: template, readiness }), true);
  });

  test("only enabled mandatory snapshot items participate in readiness", () => {
    const template = [
      { ...LEGACY_CHECKLIST[0], id: "required-custom", order: 0 },
      { ...LEGACY_CHECKLIST[1], id: "optional-custom", order: 1, mandatory: false },
    ];
    const readiness = readinessFromChecklist(template);
    assert.equal(mandatoryChecklistReady({ checklistSnapshot: template, readiness }), false);
    readiness[0].status = "ready";
    assert.equal(mandatoryChecklistReady({ checklistSnapshot: template, readiness }), true);
  });

  test("only organization owners and admins may mutate checklist configuration", () => {
    assert.equal(isChecklistAdministrator("owner"), true);
    assert.equal(isChecklistAdministrator("admin"), true);
    assert.equal(isChecklistAdministrator("member"), false);
    assert.equal(isChecklistAdministrator(undefined), false);
  });

  test("only a distinct plan approval checkpoint bypasses plan gates", () => {
    assert.equal(checkpointSkipsPlanApproval("plan-approved"), true);
    assert.equal(checkpointSkipsPlanApproval("intake-approved"), false);
    assert.equal(checkpointSkipsPlanApproval("plan"), false);
    assert.equal(checkpointSkipsPlanApproval("initial"), false);
  });
});