import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/react';
import { pinOrganizationIdForPage, getGetWorkforceInsightsQueryKey } from '@workspace/api-client-react';
import { NeedsAttentionTab } from '../../pages/action-center-tabs';
import { useWorkforceScope } from './use-workforce-insights';

test('Action Center refreshes reviews without duplicate work and fails closed across refresh, filters, tenant, account and session', async () => {
  const dom = new Window({ url: 'http://localhost/approvals' });
  const names = ['window', 'document', 'navigator', 'location', 'self', 'HTMLElement', 'HTMLInputElement',
    'Event', 'Node', 'Text', 'MutationObserver', 'addEventListener', 'removeEventListener', 'history', 'IS_REACT_ACT_ENVIRONMENT'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true :
      name === 'addEventListener' || name === 'removeEventListener' ? dom[name].bind(dom) :
      (dom as unknown as Record<string, unknown>)[name] });
  const oldFetch = globalThis.fetch;
  let actor = 'admin', session = 'session-a', org = 'client-a', denied = false, failure = false;
  let reviewStatus = 'open';
  let holdResponse: (() => void) | undefined;
  let delay = false;
  const requests: string[] = [];
  const review = { id: 'persisted-review', reference: 'EW-PRIVATE', caseId: 41, kind: 'talent-risk',
    priority: 'critical', ownerUserId: 'admin', dueDate: '2026-11-01', status: 'open', history: [] };
  globalThis.fetch = (async (input, init) => {
    const path = String(input); requests.push(path);
    if (!path.includes('workforce-insights')) {
      return new Response(JSON.stringify(path.includes('action-center') ? {
        approvals: [], completed: [], notifications: [], documentFollowups: [], workItems: [], opportunities: [], domainRecords: [], caseSummaries: [],
        offboardingSource: 'available',
        counts: { pendingApprovals: 0, notifications: 0, missingDocuments: 0, openWorkItems: 0, opportunities: 0, completed: 0 },
      } : []), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (init?.method === 'PATCH') reviewStatus = 'resolved';
    const code = denied ? 403 : failure ? 503 : 200;
    const body = code !== 200 ? { message: 'Unavailable' } : {
      organizationId: org, reviews: [{ ...review, status: reviewStatus }], owners: [{ userId: 'admin', label: 'Current owner' }],
      subjects: [], version: 1, canManage: true,
    };
    if (delay) { delay = false; await new Promise<void>(resolve => { holdResponse = resolve; }); }
    return new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.body);
  const TestAuth = ClerkProvider as unknown as React.ComponentType<{ children: React.ReactNode; user: { id: string }; sessionId: string }>;
  function UpdateHarness() {
    const scope = useWorkforceScope();
    return <button id="resolve" onClick={() => scope.update.mutate({ reviewId: review.id,
      data: { version: 1, status: 'resolved', ownerUserId: 'admin', dueDate: review.dueDate, outcome: 'Clarified' } })}>Resolve existing review</button>;
  }
  const render = () => root.render(<QueryClientProvider client={client}><TestAuth user={{ id: actor }} sessionId={session}>
    <NeedsAttentionTab /><UpdateHarness />
  </TestAuth></QueryClientProvider>);
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  const wait = async () => { await act(async () => { await settle(); }); };
  const refresh = async () => { await act(async () => { await client.invalidateQueries({ queryKey: getGetWorkforceInsightsQueryKey() }); }); await wait(); };
  const text = () => dom.document.body.textContent!;
  pinOrganizationIdForPage(org);
  try {
    await act(async () => { render(); await settle(); }); await wait();
    assert.match(text(), /EW-PRIVATE/); assert.match(text(), /1 matching attention item/);
    assert.doesNotMatch(text(), /No matching attention items/);
    assert.equal(dom.document.querySelector('[data-testid="link-review-persisted-review"]')?.getAttribute('href'), '/analytics#review-persisted-review');
    assert.equal(dom.document.querySelector('[data-testid="link-source-case-persisted-review"]')?.getAttribute('href'), '/cases/41');
    await act(async () => { (dom.document.getElementById('resolve') as unknown as HTMLButtonElement).click(); }); await wait(); await wait();
    assert.doesNotMatch(text(), /EW-PRIVATE/);
    assert.match(text(), /0 matching attention items/); assert.match(text(), /No matching attention items/);
    assert.equal(reviewStatus, 'resolved', 'the existing review changes; no new review is created');
    reviewStatus = 'in-progress'; await refresh(); assert.match(text(), /EW-PRIVATE/);
    const safety = [...dom.document.querySelectorAll('input')].find(input => input.parentElement?.textContent?.includes('Safety-critical only'))!;
    await act(async () => { safety.click(); }); await wait();
    assert.ok(requests.some(path => path.includes('workforce-insights') && path.includes('safetyCritical=true')));
    denied = true; await refresh();
    assert.doesNotMatch(text(), /EW-PRIVATE/); assert.match(text(), /administrator and source-case access/);
    assert.doesNotMatch(text(), /No matching attention items/);
    assert.match(text(), /Job context filters/);
    denied = false;
    const retry = [...dom.document.querySelectorAll('button')].find(button => button.textContent === 'Retry reviews')!;
    await act(async () => { retry.click(); }); await wait(); assert.match(text(), /EW-PRIVATE/);
    failure = true; await refresh(); assert.doesNotMatch(text(), /EW-PRIVATE/); assert.match(text(), /could not be loaded/);
    failure = false; await refresh();
    // Start a response in the old scope, then change client and deny the new scope.
    delay = true;
    await act(async () => { void client.invalidateQueries({ queryKey: getGetWorkforceInsightsQueryKey() }); await settle(); });
    org = 'client-b'; actor = 'other-admin'; denied = true; pinOrganizationIdForPage(org);
    await act(async () => { render(); }); assert.doesNotMatch(text(), /EW-PRIVATE/);
    holdResponse?.(); await wait(); assert.doesNotMatch(text(), /EW-PRIVATE/);
    denied = false; await refresh(); assert.match(text(), /EW-PRIVATE/);
    session = 'session-renewed'; denied = true;
    await act(async () => { render(); }); assert.doesNotMatch(text(), /EW-PRIVATE/); await wait();
    assert.doesNotMatch(text(), /EW-PRIVATE/);
    assert.ok(client.getQueryCache().findAll({ queryKey: getGetWorkforceInsightsQueryKey() }).every(q =>
      q.queryKey[1] === org && q.queryKey[2] === actor && q.queryKey[3] === session));
  } finally {
    holdResponse?.();
    await act(async () => { root.unmount(); }); client.clear(); pinOrganizationIdForPage(null);
    globalThis.fetch = oldFetch; dom.close();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
