import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { HroEmailTurnaround } from '@workspace/api-client-react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/react';
import { getGetHroEmailIntakeQueryKey, pinOrganizationIdForPage } from '@workspace/api-client-react';
import { readFileSync } from 'node:fs';

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

test('pages place only the summary on intake and refresh the independent report in Analytics', () => {
  const intake = readFileSync('src/pages/email-intake/index.tsx', 'utf8');
  const analytics = readFileSync('src/pages/analytics.tsx', 'utf8');
  assert.match(intake, /<PendingEmailSummary data=\{d.turnaround\}/);
  assert.doesNotMatch(intake, /<ReviewTurnaround/);
  assert.match(intake, /sm:hidden" aria-label="Client email requests"/);
  assert.match(intake, /hidden min-w-0 max-w-full overflow-x-auto sm:block/);
  assert.match(intake, /data-testid=\{`link-request-mobile-\$\{r.id\}`\}/);
  assert.match(analytics, /<EmailTurnaroundReport \/>/);
  assert.match(analytics, /invalidateQueries\(\{ queryKey: \[\.\.\.getGetHroEmailIntakeQueryKey\(\), emailScope\], exact: true \}\)/);
});

test('Analytics report uses authorized scoped readiness only and hides old totals on client, user, session and denial changes', async () => {
  const dom = new Window({ url: 'http://localhost/analytics#human-review-turnaround' });
  Object.assign(globalThis, { window: dom, document: dom.document, HTMLElement: dom.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import('react-dom/client');
  const { EmailTurnaroundReport } = await import('../analytics/email-turnaround');
  const Auth = ClerkProvider as unknown as React.ComponentType<{ children: React.ReactNode; user: { id: string }; sessionId: string }>;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let user = 'reader', session = 'session-1', org = 'client-a', status = 200, pending = 123;
  let denialCode = 'EMAIL_INTAKE_DEMO_RESTRICTED';
  let delayed: ((response: Response) => void) | undefined;
  let delay = false;
  const calls: { url: string; org: string | null }[] = [];
  const originalFetch = globalThis.fetch;
  const none = { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null };
  const response = () => new Response(JSON.stringify(status === 200 ? { turnaround: {
    asOf: '2026-10-13T00:00:00Z', waiting: { under24Hours: pending, from24To72Hours: 0, from72To168Hours: 0, atLeast168Hours: 0 },
    firstReview: none, heldConversion: none, cohorts: { basis: 'recorded-intake-receipt', timeZone: 'UTC', weekly: [], monthly: [] },
  } } : { code: status === 403 ? denialCode : undefined }), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), org: new Headers(init?.headers).get('x-organization-id') });
    if (delay) return new Promise<Response>(resolve => { delayed = resolve; });
    return response();
  }) as typeof fetch;
  const root = createRoot(document.body);
  const render = () => {
    pinOrganizationIdForPage(org);
    root.render(<QueryClientProvider client={client}><Auth user={{ id: user }} sessionId={session}>
      <div data-testid="unrelated-analytics">Case analytics still available</div><EmailTurnaroundReport />
    </Auth></QueryClientProvider>);
  };
  const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 40)); }); };
  const text = () => document.body.textContent!;
  try {
    await act(async () => render()); await settle();
    assert.match(text(), /123/);
    assert(document.getElementById('human-review-turnaround'));
    // Report's own loading state does not block the remaining Analytics content.
    org = 'client-b'; delay = true;
    await act(async () => render());
    assert.doesNotMatch(text(), /123/);
    assert.match(text(), /Case analytics still available/);
    pending = 456; delay = false;
    await act(async () => delayed?.(response())); await settle();
    assert.match(text(), /456/);
    user = 'other-reader'; pending = 789;
    await act(async () => render());
    assert.doesNotMatch(text(), /456/);
    await settle(); assert.match(text(), /789/);
    session = 'session-2'; status = 403;
    await act(async () => render());
    assert.doesNotMatch(text(), /789/);
    await settle();
    assert.match(text(), /Public Demo access cannot open Email Intake/);
    assert.match(text(), /Case analytics still available/);
    // Renewed session has its own fresh query, and refresh replaces current totals.
    session = 'session-3'; status = 200; pending = 321;
    await act(async () => render()); await settle(); assert.match(text(), /321/);
    pending = 654;
    await act(async () => { await client.invalidateQueries({ queryKey: [...getGetHroEmailIntakeQueryKey(), `${org}:${user}:${session}`], exact: true }); });
    await settle(); assert.match(text(), /654/); assert.doesNotMatch(text(), /321/);
    // A response started before renewal cannot replace the renewed session's totals.
    delay = true;
    let staleRefresh: Promise<void> | undefined;
    await act(async () => { staleRefresh = client.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }); });
    const oldReply = delayed;
    const staleBody = response();
    session = 'session-4'; delay = false; pending = 987;
    await act(async () => render()); await settle();
    assert.match(text(), /987/); assert.doesNotMatch(text(), /654/);
    await act(async () => { oldReply?.(staleBody); await staleRefresh; }); await settle();
    assert.match(text(), /987/); assert.doesNotMatch(text(), /654/);
    client.setQueryData(['/api/onboarding/email-intake/requests', `${org}:${user}:${session}`], [{ id: 'private-request' }]);
    status = 403; denialCode = 'ADMIN_GRANT_INVALID';
    await act(async () => { await client.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }); }); await settle();
    assert.match(text(), /Administrator verification expired/);
    assert.doesNotMatch(text(), /987/);
    assert.equal(client.getQueryData(['/api/onboarding/email-intake/requests', `${org}:${user}:${session}`]), undefined);
    status = 503;
    await act(async () => { await client.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }); });
    await settle();
    assert.doesNotMatch(text(), /654/);
    assert.match(text(), /Retry/); assert.match(text(), /Case analytics still available/);
    status = 401;
    await act(async () => { await client.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }); });
    await settle();
    assert.match(text(), /sign-in session ended/);
    assert(calls.every(call => call.url === '/api/onboarding/email-intake'));
    assert(calls.some(call => call.org === 'client-a') && calls.some(call => call.org === 'client-b'));
  } finally {
    await act(async () => root.unmount());
    client.clear(); pinOrganizationIdForPage(null); globalThis.fetch = originalFetch;
    await dom.happyDOM.close();
  }
});
