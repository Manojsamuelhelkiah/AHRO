import assert from "node:assert/strict";
import { test } from "node:test";
import { CONDITIONS, defineFlow, evaluateAction, type Facts, type Definition } from "./contract";
import { DEFINITIONS, ONBOARDING_V1, SEPARATION_V1, definitionDigest } from "./definitions";

const facts = (overrides: Partial<Facts> = {}): Facts =>
  ({ ...Object.fromEntries(CONDITIONS.map(condition => [condition, false])), always: true, ...overrides }) as Facts;
test("registered definitions are deeply immutable, deterministic and version-qualified", () => {
  for (const definition of DEFINITIONS) {
    assert.deepEqual(defineFlow(definition), definition);
    assert.match(definitionDigest(definition), /^[a-f0-9]{64}$/);
    assert.ok(Object.isFrozen(definition.stages[0].prerequisites));
    assert.throws(() => { (definition.stages as unknown[]).push({}); });
  }
});
test("dangling dependencies, cycles, free-form conditions and unknown handlers fail registration", () => {
  const invalid = (change: (d: Definition) => void) => {
    const d = structuredClone(ONBOARDING_V1);
    change(d);
    assert.throws(() => defineFlow(d));
  };
  invalid(d => { (d.stages[0].prerequisites as string[]).push("missing"); });
  invalid(d => { (d.stages[0].prerequisites as string[]).push("plan"); });
  invalid(d => { d.actions[0].handler = "uploaded.code" as never; });
  invalid(d => { (d.actions[0].requires as string[]).push("model says approved"); });
  invalid(d => { d.actions[0].reworkTo = "missing"; });
  invalid(d => { d.actions[0].handler = "separation.plan"; });
});
test("explicit rework loops do not create prerequisite cycles or downstream completion", () => {
  assert.equal(evaluateAction(ONBOARDING_V1, "reconcile", facts()).eligible, true);
  assert.equal(evaluateAction(ONBOARDING_V1, "connector", facts()).eligible, false);
  assert.equal(evaluateAction(SEPARATION_V1, "screen", facts()).eligible, true);
  assert.equal(evaluateAction(SEPARATION_V1, "exchange", facts()).eligible, false);
});
test("actions cannot select an unauthorized stage or bypass required domain facts", () => {
  assert.throws(() => evaluateAction(SEPARATION_V1, "finalize", facts()));
  assert.throws(() => evaluateAction(ONBOARDING_V1, "arbitrary-plan", facts()));
  assert.equal(evaluateAction(ONBOARDING_V1, "workstreams",
    facts({ "offer-released": true, "intake-released": true, "plan-released": false })).eligible, false);
  assert.equal(evaluateAction(ONBOARDING_V1, "workstreams",
    facts({ "offer-released": true, "intake-released": true, "plan-released": true })).eligible, true);
});
test("only registered handler actions may appear in executable continuations", () => {
  for (const value of Object.values(ONBOARDING_V1.continuations!)) {
    assert.ok(value.every(id => ONBOARDING_V1.actions.some(action => action.id === id)));
  }
  const changed = structuredClone(ONBOARDING_V1) as Definition;
  changed.continuations = { initial: ["arbitrary-plan"] };
  assert.throws(() => defineFlow(changed));
  const duplicate = structuredClone(ONBOARDING_V1) as Definition;
  duplicate.continuations = { initial: ["plan", "plan"] };
  assert.throws(() => defineFlow(duplicate));
  const unsupported = structuredClone(ONBOARDING_V1) as Definition;
  unsupported.continuations = { initial: ["offer"] };
  assert.throws(() => defineFlow(unsupported), /Unsupported executable continuation handler/);
  assert.equal(new Set(DEFINITIONS.map(d => `${d.id}:${d.version}`)).size, DEFINITIONS.length);
});
