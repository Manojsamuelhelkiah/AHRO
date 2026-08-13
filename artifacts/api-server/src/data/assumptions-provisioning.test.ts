import { test } from "node:test";
import assert from "node:assert/strict";
import { assumptions, assumptionMap } from "./assumptions";
import { OVERRIDABLE_ASSUMPTION_KEYS } from "../lib/rollup";

test("every assumption carries a valid provisioning demarcation", () => {
  for (const a of assumptions) {
    assert.ok(
      ["core", "configurable", "custom"].includes(a.provisioning),
      `${a.key} has invalid provisioning "${a.provisioning}"`,
    );
  }
});

test("every scenario-overridable assumption is tagged configurable", () => {
  for (const key of OVERRIDABLE_ASSUMPTION_KEYS) {
    const a = assumptionMap[key];
    assert.ok(a, `overridable key ${key} missing from register`);
    assert.equal(
      a.provisioning,
      "configurable",
      `${key} is scenario-overridable but tagged "${a.provisioning}" — core/custom values must not be client dials`,
    );
  }
});
