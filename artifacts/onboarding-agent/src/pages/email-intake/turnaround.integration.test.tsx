import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { HroEmailTurnaround } from '@workspace/api-client-react';

test('weekly and monthly selector compares receipt cohorts without changing the live pending queue', async () => {
  const dom = new Window({ url: 'http://localhost/email-intake' });
  Object.assign(globalThis, {
    window: dom, document: dom.document, HTMLElement: dom.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import('react-dom/client');
  const { ReviewTurnaround } = await import('./turnaround');
  const root = createRoot(document.body);
  const none = { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null };
  const cohort = (startAt: string, endAt: string, requestCount: number) => ({
    startAt, endAt, requestCount, pendingCount: 2,
    firstReview: { sampleCount: 3, missingEvidenceCount: 1, meanHours: 12, medianHours: 10, p90Hours: 18 },
    heldConversion: none,
  });
  const data: HroEmailTurnaround = {
    asOf: '2026-10-13T00:00:00Z',
    waiting: { under24Hours: 7, from24To72Hours: 3, from72To168Hours: 2, atLeast168Hours: 1 },
    firstReview: none, heldConversion: none,
    cohorts: {
      basis: 'recorded-intake-receipt', timeZone: 'UTC',
      weekly: [cohort('2026-10-12T00:00:00Z', '2026-10-19T00:00:00Z', 6),
        cohort('2026-09-28T00:00:00Z', '2026-10-05T00:00:00Z', 5)],
      monthly: [cohort('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 11)],
    },
  };
  try {
    await act(async () => root.render(<ReviewTurnaround data={data} />));
    const queue = document.querySelector('dl')!.outerHTML;
    const select = document.querySelector('select')!;
    const choose = async (value: string) => {
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
      });
      assert.equal(document.querySelector('dl')!.outerHTML, queue);
    };
    await choose('weekly');
    assert.match(document.querySelector('table')!.textContent!, /2026-10-12 to 2026-10-19/);
    assert.match(document.querySelector('table')!.textContent!, /2026-09-28 to 2026-10-05/);
    assert.match(document.querySelector('table')!.textContent!, /Partial period/);
    assert.match(document.querySelector('table')!.textContent!, /Missing dated evidence/);
    await choose('monthly');
    assert.match(document.querySelector('table')!.textContent!, /2026-10-01 to 2026-11-01/);
    assert.doesNotMatch(document.querySelector('table')!.textContent!, /2026-10-12/);
    await choose('all');
    assert.match(document.querySelector('caption')!.textContent!, /across all retained/);
    assert.doesNotMatch(document.querySelector('table')!.textContent!, /2026-10-01/);
    // Refreshed tenant data must replace previously displayed aggregates.
    await choose('weekly');
    await act(async () => root.render(<ReviewTurnaround data={{
      ...data, cohorts: { ...data.cohorts, weekly: [], monthly: [] },
      waiting: { under24Hours: 0, from24To72Hours: 0, from72To168Hours: 0, atLeast168Hours: 0 },
    }} />));
    assert.match(document.body.textContent!, /No retained requests for receipt-cohort comparison/);
    assert.match(document.body.textContent!, /No pending client requests/);
    assert.doesNotMatch(document.querySelector('table')!.textContent!, /2026-10-12/);
    assert.match(document.body.textContent!, /not a completed HR outcome/);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
  }
});
