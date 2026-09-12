import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyWorkforceContext,
  starterTemplate,
  WORKFORCE_STARTER_TEMPLATES,
} from "./workforce-policies";

describe("context-aware workforce policies", () => {
  test("uses explicit work facts and leaves incomplete context for review", () => {
    assert.equal(classifyWorkforceContext({}), null);
    assert.equal(classifyWorkforceContext({ roleFamily: "engineering" })?.label, "needs-review");
    assert.equal(classifyWorkforceContext({ workEnvironment: "office" })?.label, "needs-review");
    assert.equal(classifyWorkforceContext({ workEnvironment: "office", siteExposure: false, safetyCritical: false })?.label, "white-collar");
    assert.equal(classifyWorkforceContext({ workEnvironment: "site", hazards: ["forklift traffic"] })?.label, "blue-collar-frontline");
    assert.equal(classifyWorkforceContext({ workEnvironment: "remote", siteExposure: true, safetyCritical: false })?.label, "mixed");
  });

  test("frontline starter has independently evidenced HSE gates and no simulated effect", () => {
    const policy = starterTemplate("frontline-site");
    const ids = policy.overrides.map((item) => item.id);
    assert.deepEqual(ids.slice(1, 4), ["medical-fitness-clearance", "safety-sign-off", "safety-competency"]);
    for (const item of policy.overrides) {
      assert.equal(item.executor, "human-task");
      assert.equal(item.completionAuthority, "designated-human");
      assert.equal(item.evidenceRequired, true);
      assert.equal(item.enforcementStage, "before-workstreams");
    }
    assert.match(JSON.stringify(policy.processPolicy), /noSubstitutes/);
  });

  test("starter templates are stable and isolated from caller edits", () => {
    assert.equal(WORKFORCE_STARTER_TEMPLATES.length, 3);
    const first = starterTemplate("office-lateral");
    first.overrides[0].label = "mutated";
    assert.notEqual(starterTemplate("office-lateral").overrides[0].label, "mutated");
  });
});