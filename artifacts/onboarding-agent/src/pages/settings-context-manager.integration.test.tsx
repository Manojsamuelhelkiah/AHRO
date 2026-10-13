import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { ClerkProvider } from '@clerk/react';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage, type HroContextHistory, type HroContextRetentionStatus } from '@workspace/api-client-react';
import { ContextManagerHistoryViewer } from './settings-context-manager';
import { ContextRetentionSettings } from './settings-context-retention';
import { Router } from 'wouter';
import { SettingsContextRelocation } from './settings-context-relocation';

// Only Clerk is stubbed by the test runner. Keep the real generated hook,
// request headers, cache and component: retained query data on a 403 is the risk.
const TestClerkProvider = ClerkProvider as unknown as React.ComponentType<{
  children: React.ReactNode; userId: string | null;
}>;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function waitFor(predicate: () => boolean, description: string) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await act(tick);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
function history(marker: string): HroContextHistory {
  return {
    available: true, operatorAvailable: true,
    transactions: [{
      id: `${marker}-transaction`, anchorId: `${marker}-anchor`,
      correlationId: `${marker}-correlation`, parentTransactionId: `${marker}-parent`,
      workflow: 'documents', status: 'running', version: 1, executorType: 'system',
      initiatorType: 'system', startedAt: '2026-10-01T00:00:00Z', finishedAt: null,
      ageSeconds: 60, steps: [{ code: 'checkpoint-recorded', createdAt: '2026-10-01T00:00:00Z' }],
    }],
  };
}
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function retention(marker: string): HroContextRetentionStatus {
  return {
    status: 'approved', holdActive: false, safeguards: `${marker}-retention-private`,
    limits: { organizations: 4, correlations: 20, transactions: 100, steps: 500, anchors: 100 },
    lastSweep: { lastSweepAt: '2026-10-01T00:00:00Z', policyRevision: 1,
      outcome: `${marker}-sweep`, transactionsPruned: 2, stepsPruned: 3, anchorsPruned: 1 },
    policy: { revision: 1, enabled: true, retentionDays: 30, purpose: `${marker}-purpose`,
      lawfulBasis: `${marker}-basis`, policyReference: `${marker}-policy`,
      approvalReference: `${marker}-approval`, approvedAt: '2026-10-01T00:00:00Z' },
  };
}
function assertHidden(marker: string) {
  assert.doesNotMatch(document.body.textContent ?? '', new RegExp(marker));
  assert.equal(document.querySelectorAll('details, a[href*="contextCorrelation"]').length, 0);
}
async function harness(surface: 'history' | 'retention' | 'legacy' = 'history', path = '/execution-history?contextView=operator', base = '') {
  const dom = new Window({ url: `http://localhost${base}${path}` });
  const names = ['window', 'document', 'location', 'history', 'self', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'addEventListener', 'removeEventListener', 'dispatchEvent'];
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const name of [...names, 'fetch', 'IS_REACT_ACT_ENVIRONMENT']) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  for (const name of names) {
    const value = (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: typeof value === 'function' ? value.bind(dom) : value });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true, writable: true, value: true,
  });
  // Wouter is imported before the test Window exists; mirror its browser
  // History instrumentation, which normally runs once at module initialization.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = dom.history[method].bind(dom.history);
    dom.history[method] = (...args: Parameters<History[typeof method]>) => {
      original(args[0], args[1], args[2] ?? undefined);
      dom.dispatchEvent(new dom.Event(method));
    };
  }
  const client = new QueryClient(); // Same defaults as App.tsx.
  const root = createRoot(document.body);
  let userId: string | null = 'operator-a';
  let allowed = true;
  let retentionAllowed = false;
  let holdResponse = false;
  const releases: (() => void)[] = [];
  const requests: { userId: string | null; organizationId: string | null; view: string | null; search: string }[] = [];
  const retentionRequests: { userId: string | null; organizationId: string | null }[] = [];
  let lastBody = history('organization-a-operator-a');
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), dom.location.href);
    assert(['/api/context-manager/transactions', '/api/context-manager/retention'].includes(url.pathname),
      `no provider or unrelated requests: ${url.pathname}`);
    assert.equal(init?.method, 'GET');
    const organizationId = new Headers(init?.headers).get('x-organization-id');
    if (url.pathname === '/api/context-manager/retention') {
      retentionRequests.push({ userId, organizationId });
      const permitted = retentionAllowed;
      const body = retention(`${organizationId}-${userId}`);
      if (holdResponse) await new Promise<void>(resolve => { releases.push(resolve); });
      return permitted ? response(body) : response({ message: 'Verified reviewer required' }, 403);
    }
    requests.push({ userId, organizationId, view: url.searchParams.get('view'), search: url.search });
    const permitted = allowed;
    const body = history(`${organizationId}-${userId}`);
    body.nextCursor = url.searchParams.has('cursor') ? null : 'older-page';
    lastBody = body;
    if (holdResponse) await new Promise<void>(resolve => { releases.push(resolve); });
    if (url.searchParams.get('view') === 'personal') {
      return response({ available: true, operatorAvailable: false, transactions: [] });
    }
    return permitted ? response(body) : response({ message: 'Live execution metadata permission required' }, 403);
  };
  const render = async (nextUserId: string | null = userId, org = 'organization-a') => {
    userId = nextUserId;
    pinOrganizationIdForPage(org);
    await act(async () => {
      root.render(<TestClerkProvider userId={userId}>
        <QueryClientProvider client={client}><Router base={base}>
          {surface === 'retention' ? <ContextRetentionSettings /> :
            surface === 'legacy' ? <SettingsContextRelocation><p>Ordinary settings</p></SettingsContextRelocation> :
              <ContextManagerHistoryViewer />}
        </Router></QueryClientProvider>
      </TestClerkProvider>);
      await tick();
    });
  };
  return {
    client, requests, retentionRequests, render, dom,
    deny: () => { allowed = false; },
    allowRetention: () => { retentionAllowed = true; },
    denyRetention: () => { retentionAllowed = false; },
    hold: () => { holdResponse = true; },
    release: async () => { holdResponse = false; await act(async () => { releases.splice(0).forEach(resolve => resolve()); await tick(); }); },
    lastBody: () => lastBody,
    cleanup: async () => {
      releases.splice(0).forEach(resolve => resolve());
      await act(async () => root.unmount());
      client.clear();
      focusManager.setFocused(undefined);
      pinOrganizationIdForPage(null);
      await dom.happyDOM.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

for (const trigger of ['Refresh', 'focus'] as const) {
  test(`open operator history hides retained metadata after expiry denial on ${trigger}`, async () => {
    const h = await harness();
    try {
      await h.render();
      await waitFor(() => document.body.textContent!.includes('organization-a-operator-a-anchor'), 'initial authorized history');
      h.deny(); // API expiry is verified separately with a fixed clock and real group fixtures.
      await act(async () => {
        if (trigger === 'Refresh') document.querySelector<HTMLButtonElement>('button')!.click();
        else { focusManager.setFocused(false); focusManager.setFocused(true); }
        await tick();
      });
      await waitFor(() => Boolean(document.querySelector('[role="alert"]')), 'denial');
      assert.equal(h.requests.length, 2, 'denial is not retried');
      assertHidden('organization-a-operator-a');
      const denied = h.client.getQueryCache().getAll().find(query =>
        query.state.status === 'error' && String(query.queryKey[0]).includes('/transactions'));
      assert.deepEqual(denied?.state.data, h.lastBody(),
        'real query cache retains old success data; error rendering must hide it');
      assert.equal(denied?.options.retry, false);
      assert.equal(denied?.observers[0]?.options.refetchInterval, 30_000);
      assert.equal(denied?.observers[0]?.options.staleTime, 0);

      // A safe personal-view escape must not keep the operator entries on screen.
      h.hold();
      await act(async () => {
        const select = document.querySelector<HTMLSelectElement>('select[aria-label="History view"]')!;
        select.value = 'personal';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await tick();
      });
      assertHidden('organization-a-operator-a');
      await waitFor(() => h.requests.length === 3, 'personal-view request');
      assert.equal(h.requests[2].view, 'personal');
      await h.release();
      await waitFor(() => document.body.textContent!.includes('No execution attempts match'), 'safe personal view');
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.equal(document.querySelector('option[value="operator"]'), null, 'personal response removes the expired operator option');
      assertHidden('organization-a-operator-a');
    } finally { await h.cleanup(); }
  });
}

test('operator query cache cannot cross user, organization or signed-out boundaries', async () => {
  const h = await harness();
  try {
    await h.render();
    await waitFor(() => document.body.textContent!.includes('organization-a-operator-a-anchor'), 'first identity');
    h.hold();
    await h.render('operator-b');
    assertHidden('organization-a-operator-a');
    await waitFor(() => h.requests.length === 2, 'new user request');
    await h.release();
    await waitFor(() => document.body.textContent!.includes('organization-a-operator-b-anchor'), 'second identity');
    h.hold();
    await h.render('operator-b', 'organization-b');
    assertHidden('organization-a-operator-b');
    await waitFor(() => h.requests.length === 3, 'new organization request');
    await h.release();
    await waitFor(() => document.body.textContent!.includes('organization-b-operator-b-anchor'), 'second organization');
    await h.render(null, 'organization-b');
    assertHidden('organization-b-operator-b');
    assert.equal(h.requests.length, 3, 'signed-out viewer must not fetch');
    assert.equal(h.retentionRequests.length, 0, 'history must not fetch retention metadata');
    assert.deepEqual(h.requests.map(({ userId, organizationId }) => ({ userId, organizationId })), [
      { userId: 'operator-a', organizationId: 'organization-a' },
      { userId: 'operator-b', organizationId: 'organization-a' },
      { userId: 'operator-b', organizationId: 'organization-b' },
    ]);
    assert.equal(h.client.getQueryCache().getAll().some(query =>
      query.queryKey.includes('operator-a') ||
      (query.queryKey.includes('operator-b') && query.queryKey.includes('organization-a'))), false,
    'inactive sensitive query data must be discarded, not kept across identity changes');
  } finally { await h.cleanup(); }
});

test('filters, correlation navigation and Back/Forward reset operator pagination with the real cache', async () => {
  const h = await harness();
  const click = async (text: string) => {
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find(button => button.textContent === text)!.click();
      await tick();
    });
  };
  try {
    await h.render();
    await waitFor(() => Boolean(document.querySelector('details')), 'history');
    await click('Older attempts');
    await waitFor(() => h.requests.at(-1)!.search.includes('cursor=older-page'), 'older page');
    await waitFor(() => document.body.textContent!.includes('Page 2'), 'page 2');
    await waitFor(() => !Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Refresh latest')!.disabled, 'older request settled');
    await click('Refresh latest');
    await waitFor(() => document.body.textContent!.includes('Page 1'), 'latest page');
    await act(async () => {
      const workflow = document.querySelector<HTMLSelectElement>('[aria-label="Workflow"]')!;
      workflow.value = 'documents';
      workflow.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
    await waitFor(() => h.requests.at(-1)!.search.includes('workflow=documents'), 'workflow filter');
    await act(async () => {
      const status = document.querySelector<HTMLSelectElement>('[aria-label="Status"]')!;
      status.value = 'failed';
      status.dispatchEvent(new Event('change', { bubbles: true }));
      await tick();
    });
    await waitFor(() => h.requests.at(-1)!.search.includes('status=failed'), 'status filter');
    // The request is observable before React Query commits its returned rows.
    await waitFor(() => Boolean(document.querySelector('a[href*="contextCorrelation"]')), 'filtered history rendered');
    await act(async () => {
      document.querySelector<HTMLAnchorElement>('a[href*="contextCorrelation"]')!.click();
      await tick();
    });
    await waitFor(() => h.requests.at(-1)!.search.includes('correlationId='), 'related attempts');
    assert.equal(h.dom.location.pathname, '/execution-history');
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="Workflow"]')!.value, '');
    await act(async () => { h.dom.history.back(); await tick(); });
    await waitFor(() => document.querySelector<HTMLSelectElement>('[aria-label="Status"]')!.value === 'failed', 'Back restores filters');
    await act(async () => { h.dom.history.forward(); await tick(); });
    await waitFor(() => document.body.textContent!.includes('Correlation filter:'), 'Forward restores correlation');
    assert.equal(h.retentionRequests.length, 0);
  } finally { await h.cleanup(); }
});

for (const surface of ['history', 'retention'] as const) {
  test(`${surface} ignores delayed responses after principal and tenant switches`, async () => {
    const h = await harness(surface);
    try {
      h.allowRetention();
      h.hold();
      await h.render();
      await waitFor(() => (surface === 'history' ? h.requests : h.retentionRequests).length === 1, 'pending first principal');
      await h.render('operator-b', 'organization-b');
      await waitFor(() => (surface === 'history' ? h.requests : h.retentionRequests).length === 2, 'pending second principal');
      await h.release();
      await waitFor(() => document.body.textContent!.includes('organization-b-operator-b'), 'new principal only');
      assert.doesNotMatch(document.body.innerHTML, /organization-a-operator-a/);
      assert.equal(h.client.getQueryCache().getAll().some(query => query.queryKey.includes('operator-a')), false);
    } finally { await h.cleanup(); }
  });
}

test('retention revocation hides cached policy and discards an open review draft', async () => {
  const h = await harness('retention', '/settings#context-metadata-retention');
  try {
    h.allowRetention();
    await h.render();
    await waitFor(() => document.body.textContent!.includes('organization-a-operator-a-retention-private'), 'reviewed policy');
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Review retention rule')!.click();
      await tick();
    });
    assert(document.querySelector('form'));
    h.denyRetention();
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await tick();
    });
    await waitFor(() => document.body.textContent!.includes('only to verified privacy or legal reviewers'), 'revoked reviewer');
    assert.equal(document.querySelector('form'), null);
    assert.doesNotMatch(document.body.innerHTML, /organization-a-operator-a/);
    assert.equal(h.retentionRequests.length, 2);
    assert.equal(h.requests.length, 0, 'Settings never requests history');
  } finally { await h.cleanup(); }
});

test('legacy Settings navigation respects a non-root app base and ordinary Settings stays put', async () => {
  const h = await harness('legacy', '/settings?contextView=operator&contextCorrelation=opaque-id#unified-context-manager', '/suite');
  try {
    await h.render();
    await waitFor(() => h.dom.location.pathname === '/suite/execution-history', 'base-aware redirect');
    assert.equal(h.dom.location.search, '?contextView=operator&contextCorrelation=opaque-id');
    assert.equal(h.requests.length + h.retentionRequests.length, 0);
    await act(async () => {
      h.dom.history.pushState(null, '', '/suite/settings#context-metadata-retention');
      h.dom.dispatchEvent(new h.dom.PopStateEvent('popstate'));
      await tick();
    });
    await waitFor(() => document.body.textContent === 'Ordinary settings', 'retention destination');
    assert.equal(h.dom.location.pathname, '/suite/settings');
    await act(async () => {
      h.dom.history.pushState(null, '', '/suite/settings#unified-context-manager');
      await tick();
    });
    await waitFor(() => h.dom.location.pathname === '/suite/execution-history', 'fragment-only in-app redirect');
  } finally { await h.cleanup(); }
});

test('a denied reviewer cannot inherit another user’s retention policy or review draft', async () => {
  const h = await harness('retention', '/settings#context-metadata-retention');
  try {
    h.allowRetention();
    await h.render();
    await waitFor(() => document.body.textContent!.includes('organization-a-operator-a-retention-private'), 'reviewer status');
    await act(async () => {
      Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Review retention rule')!.click();
      await tick();
    });
    assert(document.querySelector('form'), 'reviewer can open the scoped draft');
    assert(Array.from(document.querySelectorAll('input')).some(input =>
      input.value === 'organization-a-operator-a-policy'));
    h.denyRetention();
    h.hold();
    await h.render('operator-b');
    assert.doesNotMatch(document.body.textContent ?? '', /organization-a-operator-a/);
    assert.equal(document.querySelector('form'), null, 'new viewer must not inherit an open review');
    await waitFor(() => h.retentionRequests.length === 2, 'new reviewer authority request');
    await h.release();
    await waitFor(() => document.body.textContent!.includes('only to verified privacy or legal reviewers'), 'reviewer denial');
    assert.equal(document.querySelector('section[aria-label="Context metadata retention"]'), null);
    assert.equal(document.querySelector('form'), null);
    assert.doesNotMatch(document.body.textContent ?? '', /organization-a-operator-a/);
  } finally { await h.cleanup(); }
});
