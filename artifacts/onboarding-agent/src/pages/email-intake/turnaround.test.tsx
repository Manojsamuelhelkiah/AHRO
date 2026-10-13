import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HroEmailTurnaround } from '@workspace/api-client-react';
import { ReviewTurnaround } from './turnaround';

const empty: HroEmailTurnaround = {
  asOf: '2026-10-13T00:00:00Z',
  waiting: { under24Hours: 0, from24To72Hours: 0, from72To168Hours: 0, atLeast168Hours: 0 },
  firstReview: { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null },
  heldConversion: { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null },
};

test('turnaround renders empty measurements honestly and preserves held-outcome and privacy boundaries', () => {
  const html = renderToStaticMarkup(<ReviewTurnaround data={empty} />);
  assert.match(html, /No pending client requests/);
  assert.equal(html.match(/Not measured/g)?.length, 6);
  assert.match(html, /not Gmail delivery/);
  assert.match(html, /not a completed HR outcome/);
  assert.match(html, /Unbound platform-triage mail and linked synthetic cases are excluded/);
  assert.match(html, /individual reviewer metrics/);
  assert.match(html, /<caption/);
  assert.doesNotMatch(html, /NaN|undefined/);
});

test('turnaround renders measured sample sizes, missing evidence and all waiting bands', () => {
  const html = renderToStaticMarkup(<ReviewTurnaround data={{
    ...empty,
    waiting: { under24Hours: 5, from24To72Hours: 3, from72To168Hours: 2, atLeast168Hours: 1 },
    firstReview: { sampleCount: 7, missingEvidenceCount: 2, meanHours: 12.25, medianHours: 10, p90Hours: 24 },
  }} />);
  for (const label of ['Under 24 hours', '24 to under 72 hours', '72 hours to under 7 days', '7 days or more',
    'First human review / rejection', 'Conversion to held case', 'Missing dated evidence']) assert.ok(html.includes(label), label);
  assert.match(html, /12\.3 h/);
  assert.match(html, /<td class="pr-3">7<\/td>/);
  assert.match(html, /<td>2<\/td>/);
  assert.doesNotMatch(html, /No pending client requests/);
});
