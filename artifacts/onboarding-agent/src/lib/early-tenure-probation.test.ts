import assert from 'node:assert/strict';
import test from 'node:test';
import { probationTiming } from './early-tenure-probation';

const timing = {
  actualJoinedAt: '2026-01-01T09:00:00.000Z',
  maturityAt: '2026-03-01T09:00:00.000Z',
  governedEndAt: '2026-03-15T09:00:00.000Z',
  now: new Date('2026-03-10T12:00:00.000Z'),
};

test('blocks premature confirmation while permitting an early extension or reviewed record', () => {
  const prematureConfirmation = probationTiming({ ...timing, disposition: 'confirmed', effectiveAt: '2026-03-10T12:00:00.000Z' });
  assert.equal(prematureConfirmation.canSubmit, false);
  assert.match(prematureConfirmation.message ?? '', /current governed probation end/);

  assert.equal(probationTiming({
    ...timing, disposition: 'extended', effectiveAt: '2026-03-10T12:00:00.000Z', extensionEndsAt: '2026-04-01T09:00:00.000Z',
  }).canSubmit, true);
  assert.equal(probationTiming({
    ...timing, disposition: 'reviewed-other', effectiveAt: '2026-01-15T12:00:00.000Z',
  }).canSubmit, true);
});

test('requires an extension to exceed the current governed end', () => {
  const result = probationTiming({
    ...timing, disposition: 'extended', effectiveAt: '2026-03-10T12:00:00.000Z', extensionEndsAt: '2026-03-15T09:00:00.000Z',
  });
  assert.equal(result.canSubmit, false);
  assert.match(result.message ?? '', /after the current governed probation end/);
});