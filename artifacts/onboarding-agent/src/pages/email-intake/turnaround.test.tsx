import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HroEmailTurnaround } from '@workspace/api-client-react';
import { ReceiptCohortRows, ReviewTurnaround } from './turnaround';

const empty: HroEmailTurnaround = {
  asOf: '2026-10-13T00:00:00Z',
  waiting: { under24Hours: 0, from24To72Hours: 0, from72To168Hours: 0, atLeast168Hours: 0 },
  firstReview: { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null },
  heldConversion: { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null },
  cohorts: { basis: 'recorded-intake-receipt', timeZone: 'UTC', weekly: [], monthly: [] },
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

test('receipt cohort selector defines calendar boundaries and preserves snapshot queue meaning', () => {
  const html = renderToStaticMarkup(<ReviewTurnaround data={empty} />);
  assert.match(html, /aria-label="Compare receipt cohorts"/);
  assert.match(html, /Weekly \(Monday start, UTC\)/);
  assert.match(html, /Monthly \(calendar month, UTC\)/);
  assert.match(html, /not human event dates/);
  assert.match(html, /does not filter the current pending queue/);
  assert.match(html, /not a complete history of deleted requests/);
  assert.match(html, /Small samples/);
});

test('cohort rows show retained, pending, sample and missing counts without claiming HR completion', () => {
  const html = renderToStaticMarkup(<table><ReceiptCohortRows asOf={empty.asOf} data={[
    { startAt: '2026-10-12T00:00:00Z', endAt: '2026-10-19T00:00:00Z', requestCount: 9, pendingCount: 4,
      firstReview: { sampleCount: 3, missingEvidenceCount: 2, meanHours: 12.25, medianHours: 10, p90Hours: 20 },
      heldConversion: empty.heldConversion },
    { startAt: '2026-09-28T00:00:00Z', endAt: '2026-10-05T00:00:00Z', requestCount: 1, pendingCount: 0,
      firstReview: empty.firstReview, heldConversion: empty.heldConversion },
  ]} /></table>);
  assert.match(html, /2026-10-12 to 2026-10-19 \(exclusive\)/);
  assert.match(html, /rowSpan="2" class="pr-3">9/);
  assert.match(html, /rowSpan="2" class="pr-3">4/);
  assert.match(html, /12\.3 h/);
  assert.equal(html.match(/Partial period/g)?.length, 1);
  assert.match(html, /Conversion to held case/);
  assert.match(html, /Missing dated evidence/);
  assert.match(html, /Not measured/);
});
