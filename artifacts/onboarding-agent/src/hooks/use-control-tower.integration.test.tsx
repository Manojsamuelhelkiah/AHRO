import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/react';
import { pinOrganizationIdForPage, getGetControlTowerExamplesQueryKey } from '@workspace/api-client-react';
import { useControlTower } from './use-control-tower';

test('overview refreshes independently, purges denied cache, and rejects delayed previous-scope disclosures', async () => {
  const dom = new Window({ url: 'http://localhost/' });
  const names = ['window', 'document', 'navigator', 'location', 'self', 'HTMLElement',
    'Event', 'Node', 'Text', 'MutationObserver', 'addEventListener', 'removeEventListener', 'history', 'IS_REACT_ACT_ENVIRONMENT'];
  const original = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, writable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true :
      name === 'addEventListener' || name === 'removeEventListener' ? dom[name].bind(dom) :
      (dom as unknown as Record<string, unknown>)[name] });
  const oldFetch = globalThis.fetch;
  let org = 'tower-a', actor = 'tower-owner', session = 'session-a', denied = false, delay = false;
  let release: (() => void) | undefined;
  let latest: ReturnType<typeof useControlTower>;
  const reads: { path: string; org: string | null }[] = [];
  globalThis.fetch = (async (input, init) => {
    const path = String(input), scope = new Headers(init?.headers).get('x-organization-id');
    reads.push({ path, org: scope });
    const fail = path.includes('/control-tower/examples') && denied;
    const body = path.includes('/control-tower/examples') ? { marker: `private-${scope}` } :
      path.endsWith('/cases') ? [{ id: 1, workerName: `case-${scope}` }] :
      path.includes('/workforce-insights') ? { organizationId: scope, reviews: [], owners: [] } :
      path.includes('/action-center') ? { marker: `attention-${scope}` } : { marker: `activity-${scope}` };
    if (delay && path.includes('/control-tower/examples')) {
      delay = false;
      await new Promise<void>(resolve => { release = resolve; });
    }
    return new Response(JSON.stringify(fail ? { message: 'Denied' } : body), {
      status: fail ? 403 : 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(document.body);
  const Auth = ClerkProvider as unknown as React.ComponentType<{ children: React.ReactNode; user: { id: string }; sessionId: string }>;
  function Probe() {
    latest = useControlTower();
    return <div>{JSON.stringify([latest.dashData.data, latest.casesData.data, latest.actionsData.data, latest.examplesData.data])}</div>;
  }
  const render = () => root.render(<QueryClientProvider client={client}><Auth user={{ id: actor }} sessionId={session}><Probe /></Auth></QueryClientProvider>);
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); }); };
  const text = () => dom.document.body.textContent ?? '';
  try {
    pinOrganizationIdForPage(org);
    await act(async () => { render(); }); await settle();
    assert.match(text(), /private-tower-a/);
    const successfulAt = latest!.examplesData.updatedAt?.getTime();
    denied = true;
    await act(async () => { await latest!.examples.refetch(); }); await settle();
    assert.doesNotMatch(text(), /private-/);
    assert.match(text(), /attention-tower-a/);
    assert.equal(latest!.examplesData.updatedAt?.getTime(), successfulAt, 'retain last successful timestamp, not private data');
    assert.equal(client.getQueryData([...getGetControlTowerExamplesQueryKey(), org, actor, session]), undefined);
    denied = false;
    await act(async () => { await latest!.examples.refetch(); }); await settle();
    assert.match(text(), /private-tower-a/);
    const previousReads = reads.length;
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); }); await settle();
    assert.ok(reads.length > previousReads, 'focus refreshes the current sources');
    delay = true;
    await act(async () => { void latest!.examples.refetch(); await new Promise(resolve => setTimeout(resolve, 15)); });
    org = 'tower-b'; actor = 'second-owner'; session = 'session-b'; denied = true;
    pinOrganizationIdForPage(org);
    await act(async () => { render(); }); await settle();
    assert.doesNotMatch(text(), /tower-a/);
    release?.(); await settle();
    assert.doesNotMatch(text(), /private-tower-a/);
    assert.match(text(), /attention-tower-b/);
    assert.equal(client.getQueryData([...getGetControlTowerExamplesQueryKey(), 'tower-a', 'tower-owner', 'session-a']), undefined);
    denied = false;
    await act(async () => { await latest!.examples.refetch(); }); await settle();
    assert.match(text(), /private-tower-b/);
    session = 'renewed-session'; denied = true;
    await act(async () => { render(); }); await settle();
    assert.doesNotMatch(text(), /private-tower-b/);
    assert.ok(reads.filter(r => r.path.includes('/control-tower/examples')).every(r => r.org === 'tower-a' || r.org === 'tower-b'));
  } finally {
    release?.();
    await act(async () => { root.unmount(); });
    client.clear(); pinOrganizationIdForPage(null); focusManager.setFocused(undefined);
    globalThis.fetch = oldFetch; await dom.happyDOM.close();
    for (const name of names) {
      const descriptor = original.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});
