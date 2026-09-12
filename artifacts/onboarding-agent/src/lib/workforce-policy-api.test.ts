import assert from 'node:assert/strict';
import test from 'node:test';
import { hasExplicitWorkforceContext, parseWorkforceTriState, updateWorkforceContext } from './workforce-policy-api';

test('workforce context editor preserves explicit negative, positive, and unknown facts', () => {
  const unknown = updateWorkforceContext({}, 'safetyCritical', undefined);
  const negative = updateWorkforceContext(unknown, 'safetyCritical', false);
  const positive = updateWorkforceContext(negative, 'siteExposure', true);
  const assistedNegative = updateWorkforceContext(positive, 'assistedIntake', false);

  assert.equal(unknown.safetyCritical, undefined);
  assert.equal(negative.safetyCritical, false);
  assert.equal(positive.siteExposure, true);
  assert.equal(positive.safetyCritical, false);
  assert.equal(assistedNegative.assistedIntake, false);
  assert.equal(hasExplicitWorkforceContext(unknown), false);
  assert.equal(hasExplicitWorkforceContext(negative), true);
  assert.equal(parseWorkforceTriState(''), undefined);
  assert.equal(parseWorkforceTriState('no'), false);
  assert.equal(parseWorkforceTriState('yes'), true);
});