import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_TYPES, casesForList, casePresentationOf, caseTitleOf, caseTypeOf, isFictionalOfflineExample } from "./case-presentation";

test("every family uses explicit request classification rather than falling back to onboarding", () => {
  for (const family of CASE_TYPES.filter(value => value !== "All Cases")) {
    for (let slot = 1; slot <= 5; slot++) {
      const c = { caseFamily: family, requestType: `${family} example ${slot}`, scenarioKey: `UAT-DEMO-EXAMPLES:additional-v1:${family}:${slot}`, hireType: "employee-service" };
      assert.equal(caseTypeOf(c), family);
      assert.equal(caseTitleOf(c), c.requestType);
      assert.equal(casePresentationOf(c)?.type, family);
      assert.equal(casePresentationOf(c)?.title, c.requestType);
    }
  }
});
test("ordinary lists retain existing fictional examples and new examples, not volunteers or unrestricted historical records", () => {
  const operational = { id: 1, controllerRetired: false };
  const existing = { id: 2, controllerRetired: true, offlineSample: true, fictionalOfflineIdentity: true };
  const added = { ...existing, id: 3 };
  const volunteer = { id: 4, controllerRetired: true, offlineSample: true, fictionalOfflineIdentity: false };
  const rows = [operational, existing, added, volunteer];
  assert.deepEqual(casesForList(rows, false), [operational, existing, added]);
  assert.deepEqual(casesForList(rows, true), [existing, added, volunteer]);
  assert.equal(isFictionalOfflineExample(volunteer), false);
});
