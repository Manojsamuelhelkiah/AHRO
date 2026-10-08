import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/react';
import { pinOrganizationIdForPage, getGetHroContextRetentionQueryKey } from '@workspace/api-client-react';
import { ContextRetentionSettings, getScopedRetentionQueryKey } from './settings-context-retention';

const TestAuthProvider = ClerkProvider as unknown as React.ComponentType<{
  children: React.ReactNode; user: { id: string } | null;
}>;

test('same-organization account switch clears reviewer retention data and requires fresh authorization', async () => {
  const dom = new Window({ url: 'http://localhost/settings' });
  const names = ['window', 'document', 'navigator', 'location', 'self', 'HTMLElement', 'HTMLInputElement',
    'Event', 'Node', 'Text', 'MutationObserver', 'IS_REACT_ACT_ENVIRONMENT'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom as unknown as Record<string, unknown>)[name] });
  }
  const originalFetch = globalThis.fetch;
  let userId = 'reviewer';
  const requests: string[] = [];
  const policy = {
    status: 'approved', holdActive: false, lastSweep: null, safeguards: 'Protected metadata only',
    limits: { organizations: 1, correlations: 2, transactions: 30, steps: 20, anchors: 30 },
    policy: { revision: 7, enabled: true, retentionDays: 90, purpose: 'reviewer-private-purpose',
      lawfulBasis: 'reviewer-private-lawful-basis', policyReference: 'reviewer-private-policy',
      approvalReference: 'reviewer-private-approval', approvedAt: '2026-10-08T00:00:00Z' },
  };
  globalThis.fetch = (async () => {
    requests.push(userId);
    return new Response(JSON.stringify(userId === 'reviewer' ? policy : { message: 'Forbidden' }),
      { status: userId === 'reviewer' ? 200 : 403, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The old unscoped key must never be used, even if another component seeded it.
  client.setQueryData(getGetHroContextRetentionQueryKey(), policy);
  const root = createRoot(document.body);
  const render = () => root.render(
    <QueryClientProvider client={client}>
      <TestAuthProvider user={userId ? { id: userId } : null}><ContextRetentionSettings /></TestAuthProvider>
    </QueryClientProvider>,
  );
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  pinOrganizationIdForPage('same-organization');
  try {
    await act(async () => { render(); await settle(); });
    await act(async () => { await settle(); });
    assert.match(dom.document.body.textContent!, /Reviewed revision 7/);
    const reviewButton = [...dom.document.querySelectorAll('button')].find(button => button.textContent === 'Review retention rule');
    assert(reviewButton);
    await act(async () => { reviewButton.click(); });
    assert.match(dom.document.body.innerHTML, /reviewer-private-lawful-basis/);

    userId = 'ordinary-member';
    await act(async () => { render(); });
    assert.doesNotMatch(dom.document.body.innerHTML, /reviewer-private|Reviewed revision 7|Record reviewed revision/);
    await act(async () => { await settle(); });
    assert.match(dom.document.body.textContent!, /only to verified privacy or legal reviewers/);
    assert.doesNotMatch(dom.document.body.innerHTML, /reviewer-private|Reviewed revision 7/);
    assert(requests.includes('ordinary-member'), 'new user must pass a real request rather than reuse reviewer data');
    assert.equal(client.getQueryData(getScopedRetentionQueryKey('reviewer', 'same-organization')), undefined);

    userId = '';
    await act(async () => { render(); });
    assert.equal(dom.document.body.textContent, '');
    assert.equal(client.getQueryData(getScopedRetentionQueryKey('ordinary-member', 'same-organization')), undefined);
  } finally {
    await act(async () => { root.unmount(); });
    client.clear();
    pinOrganizationIdForPage(null);
    globalThis.fetch = originalFetch;
    dom.close();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
