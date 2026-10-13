import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { ClerkProvider } from '@clerk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage, type SeparationPolicyRecord } from '@workspace/api-client-react';
import { Router } from 'wouter';
import { OffboardingSettingsPage } from './settings-offboarding';
import { SeparationPoliciesPage } from './cases/separations/policies';

const TestClerk = ClerkProvider as unknown as React.ComponentType<{ children: React.ReactNode; user: { id: string } }>;
const allows = ['flow.case.read', 'data.case.profile.read', 'flow.case.edit', 'data.case.profile.edit', 'tool.policy.manage'];
const saved: SeparationPolicyRecord = { id: 'fixture-policy', version: 1, status: 'proposal', createdBy: 'proposer',
  policy: { country: 'US', role: 'Engineer', workerCategory: 'employee', timeZone: 'America/New_York', endOfLwd: '17:00',
    rulesReference: 'rules-fixture', retentionReference: 'retention-fixture', defaultAssets: ['laptop'], obligations: [] } };

async function harness() {
  const dom = new Window({ url: 'http://localhost/settings/offboarding' });
  const names = ['window', 'document', 'location', 'history', 'self', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event',
    'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener',
    'removeEventListener', 'dispatchEvent', 'fetch', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = (dom as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: typeof value === 'function' ? value.bind(dom) : value });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
  // Load React's DOM event support after the test DOM exists.
  const { createRoot } = await import('react-dom/client');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRoot(document.body);
  let org = 'client-a', user = 'reviewer', context: 'settings' | 'cases' = 'settings';
  let permissions = allows;
  let rows: SeparationPolicyRecord[] = [structuredClone(saved)];
  let listStatus = 200, mutationStatus = 201;
  let holdList = false;
  const releases: (() => void)[] = [];
  const writes: { org: string | null; body: Record<string, unknown>; path: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), dom.location.href).pathname;
    const headers = new Headers(init?.headers);
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (path.endsWith('/human-permissions')) return response({ allows: permissions });
    assert.match(path, /^\/api\/offboarding\/policies/);
    if (init?.method === 'GET') {
      const body = structuredClone(rows), status = listStatus;
      if (holdList) await new Promise<void>(resolve => releases.push(resolve));
      return response(status === 200 ? body : { message: 'Current access is required.' }, status);
    }
    const body = JSON.parse(String(init?.body));
    writes.push({ org: headers.get('x-organization-id'), body, path });
    if (mutationStatus >= 400) return response({ message: mutationStatus === 409 ? 'Policy changed; supply its latest expectedVersion.' : 'Service unavailable.' }, mutationStatus);
    if (path.endsWith('/decision')) {
      rows = rows.map(p => ({ ...p, status: body.decision === 'approve' ? 'approved' : 'withdrawn' }));
      return response(rows[0]);
    }
    const p: SeparationPolicyRecord = { id: body.id ?? 'new-fixture', version: body.expectedVersion + 1,
      status: 'proposal', policy: body.policy, createdBy: user };
    rows = [...rows, p];
    return response(p, 201);
  };
  async function render() {
    pinOrganizationIdForPage(org);
    await act(async () => root.render(<TestClerk user={{ id: user }}><QueryClientProvider client={client}>
      <Router>{context === 'settings' ? <OffboardingSettingsPage /> : <SeparationPoliciesPage />}</Router>
    </QueryClientProvider></TestClerk>));
  }
  async function wait(predicate: () => boolean) {
    for (let i = 0; i < 80; i++) {
      if (predicate()) return;
      await act(() => new Promise<void>(resolve => setTimeout(resolve, 5)));
    }
    assert.fail(`Timed out: ${document.body.textContent}`);
  }
  const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!;
  async function click(id: string) { assert.ok(button(id)); await act(async () => button(id).click()); }
  async function fill(id: string, value: string) {
    const el = document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
    assert.ok(el);
    await act(async () => {
      // Native setter bypasses React's tracker just as a real input event does.
      Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
  await render();
  return { render, wait, click, fill, button, writes, client,
    setContext: (v: typeof context) => { context = v; },
    setOrg: (v: string) => { org = v; },
    setUser: (v: string) => { user = v; },
    setPermissions: (v: string[]) => { permissions = v; },
    setRows: (v: SeparationPolicyRecord[]) => { rows = v; },
    setListStatus: (v: number) => { listStatus = v; },
    setMutationStatus: (v: number) => { mutationStatus = v; },
    hold: () => { holdList = true; },
    release: () => { holdList = false; releases.splice(0).forEach(resolve => resolve()); },
    async dispose() {
      holdList = false; releases.splice(0).forEach(resolve => resolve());
      await act(async () => root.unmount());
      client.clear(); pinOrganizationIdForPage(null);
      await dom.happyDOM.abort();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('both screens share saved decisions; proposals and conflicts retain draft inputs', async () => {
  const h = await harness();
  try {
    await h.wait(() => !!h.button('button-approve-fixture-policy-1'));
    assert.match(document.body.textContent!, /Offboarding configuration/);
    assert.ok(document.querySelector('a[href="/settings"]'));
    await h.fill('input-decision-ref-fixture-policy-1', 'independent-review');
    await h.click('button-approve-fixture-policy-1');
    await h.wait(() => document.body.textContent!.includes('approved'));
    h.setContext('cases'); await h.render();
    await h.wait(() => document.body.textContent!.includes('Offboarding policies'));
    assert.match(document.body.textContent!, /approved/);
    await h.click('button-revise-fixture-policy-1');
    await h.fill('input-policy-role', 'Retained revision draft');
    h.setMutationStatus(409);
    await h.click('button-submit-policy');
    await h.wait(() => document.body.textContent!.includes('Policy changed'));
    assert.equal(document.querySelector<HTMLInputElement>('[data-testid="input-policy-role"]')!.value, 'Retained revision draft');
    assert.equal(h.writes.at(-1)!.body.expectedVersion, 1);
    assert.equal(h.writes.at(-1)!.org, 'client-a');
    h.setMutationStatus(503);
    await h.click('button-submit-policy');
    await h.wait(() => document.body.textContent!.includes('Service unavailable'));
    assert.equal(document.querySelector<HTMLInputElement>('[data-testid="input-policy-role"]')!.value, 'Retained revision draft');
    h.setMutationStatus(201);
    await h.click('button-submit-policy');
    await h.wait(() => !!document.querySelector('[data-testid="card-policy-fixture-policy-2"]'));
    assert.equal(document.querySelector('[data-testid="input-policy-role"]'), null);
    assert.match(document.body.textContent!, /proposal/);
    assert.equal(h.button('button-approve-fixture-policy-2'), null, 'self-approval is not offered');
  } finally { await h.dispose(); }
});

test('scope remount removes drafts and ignores late list results; denied/filtered lists are not empty inventories', async () => {
  const h = await harness();
  try {
    await h.wait(() => !!h.button('button-revise-fixture-policy-1'));
    await h.click('button-revise-fixture-policy-1');
    await h.fill('input-policy-role', 'client-a-private-draft');
    h.hold();
    void h.client.invalidateQueries({ queryKey: ['/api/offboarding/policies'] });
    await act(() => new Promise<void>(resolve => setTimeout(resolve, 10)));
    h.setRows([]); h.setOrg('client-b'); await h.render();
    assert.equal(document.querySelector('[data-testid="input-policy-role"]'), null);
    assert.doesNotMatch(document.body.textContent!, /client-a-private-draft|rules-fixture/);
    h.release();
    await h.wait(() => document.body.textContent!.includes('No policies are visible'));
    assert.doesNotMatch(document.body.textContent!, /rules-fixture/);
    assert.match(document.body.textContent!, /permission-filtered/);
    h.setPermissions(['flow.case.read', 'data.case.profile.read']); h.setUser('read-only'); await h.render();
    await h.wait(() => document.body.textContent!.includes('Permission-limited'));
    assert.equal(h.button('button-new-policy').disabled, true);
    h.setListStatus(403);
    await act(async () => { await h.client.invalidateQueries({ queryKey: ['/api/offboarding/policies'] }); });
    await h.wait(() => document.body.textContent!.includes('Access denied'));
    assert.doesNotMatch(document.body.textContent!, /No policies are visible/);
    assert.equal(h.writes.length, 0);
  } finally { await h.dispose(); }
});
