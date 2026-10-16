import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ClerkProvider } from '@clerk/react';
import { pinOrganizationIdForPage, type AgentCatalogue } from '@workspace/api-client-react';
import type { RegistrationForm as Form } from './registration-form';

const snapshot = (): AgentCatalogue => ({
  organizationId: 'client-a', clientName: 'Fixture client', version: 'v1', canManage: true,
  entries: ['onboarding', 'payroll', 'leave'].map(key => ({
    key, name: `${key} role`, version: 'v1', kind: 'domain', responsibility: 'Setup only',
    productFamilies: [], prerequisites: [], operationalCapability: 'unavailable', mappings: [],
  })),
  principals: [
    { id: 'principal-a', name: 'Saved Alpha', ownerUserId: 'owner-a', status: 'active', version: 3 },
    { id: 'principal-b', name: 'Saved Beta', ownerUserId: 'owner-b', status: 'active', version: 7 },
    { id: 'principal-c', name: 'Saved Gamma', ownerUserId: 'owner-a', status: 'active', version: 2 },
    { id: 'principal-retired', name: 'Retired principal', ownerUserId: 'owner-a', status: 'retired', version: 4 },
    { id: 'principal-revoked', name: 'Revoked principal', ownerUserId: 'owner-a', status: 'revoked', version: 5 },
    { id: 'principal-orphan', name: 'Orphan principal', ownerUserId: 'absent-owner', status: 'active', version: 1 },
  ],
  registrations: [
    { catalogueKey: 'onboarding', catalogueVersion: 'v1', agentId: 'principal-a', principalVersion: 3, version: 2, state: 'registered' },
    { catalogueKey: 'payroll', catalogueVersion: 'v1', agentId: 'principal-b', principalVersion: 7, version: 1, state: 'registered' },
  ],
  owners: [
    { clerkUserId: 'owner-a', role: 'owner', name: 'Accountable Alpha', email: null, identityResolution: 'resolved', accountKind: 'human' },
    { clerkUserId: 'owner-b', role: 'member', name: 'Accountable Beta', email: null, identityResolution: 'resolved', accountKind: 'human' },
  ],
  customMappings: [], runtimeCapabilities: [], runtimeNotice: 'Setup only',
});

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
type Driver = {
  render: (cat: AgentCatalogue, selection?: { key: string; revision: number }, scope?: string) => Promise<void>;
  renderCatalogue: (searchTerm?: string, scope?: { userId: string; sessionId: string; orgId: string }) => Promise<void>;
  refreshCatalogue: () => Promise<void>;
  choose: (id: string, value: string) => Promise<void>;
  click: (id: string) => Promise<void>;
  text: (id: string) => string;
  value: (id: string) => string;
  disabled: () => boolean;
  checked: () => boolean;
  dom: Window;
  client: QueryClient;
};
async function fixture(run: (d: Driver) => Promise<void>, handler: typeof fetch = async () => {
  throw new Error('Unexpected request');
}) {
  const dom = new Window({ url: 'http://localhost/agents' });
  const globals = ['window', 'document', 'navigator', 'location', 'localStorage', 'sessionStorage', 'self', 'history',
    'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Event', 'CustomEvent', 'Node', 'NodeFilter',
    'Text', 'MutationObserver', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const oldFetch = globalThis.fetch;
  for (const name of globals) Object.defineProperty(globalThis, name, {
    configurable: true, writable: true,
    value: name === 'IS_REACT_ACT_ENVIRONMENT' ? true : (dom as unknown as Record<string, unknown>)[name],
  });
  globalThis.fetch = handler;
  pinOrganizationIdForPage('client-a');
  const { createRoot } = await import('react-dom/client');
  const { RegistrationForm } = await import('./registration-form');
  const root = createRoot(document.body);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = (id: string) => dom.document.querySelector(`[data-testid="${id}"]`)!;
  const driver: Driver = {
    dom, client,
    render: async (catalogue, selection, scope = 'session-a') => {
      await act(async () => {
        const props: React.ComponentProps<typeof Form> = { catalogue, selection, queryScope: ['agent-catalogue', scope] };
        root.render(<QueryClientProvider client={client}><RegistrationForm key={scope} {...props} /></QueryClientProvider>);
        await settle();
      });
    },
    renderCatalogue: async (searchTerm = '', scope) => {
      const { CatalogueSection } = await import('./catalogue-section');
      const Auth = ClerkProvider as unknown as React.ComponentType<{ children: React.ReactNode; user: { id: string }; sessionId?: string }>;
      if (scope) pinOrganizationIdForPage(scope.orgId);
      dom.HTMLElement.prototype.scrollIntoView = () => {};
      await act(async () => {
        root.render(<QueryClientProvider client={client}><Auth user={{ id: scope?.userId ?? 'fixture-admin' }} sessionId={scope?.sessionId}><CatalogueSection searchTerm={searchTerm} /></Auth></QueryClientProvider>);
        await settle();
      });
      await act(settle);
    },
    refreshCatalogue: async () => {
      await act(async () => { await client.refetchQueries({ queryKey: ['agent-catalogue'] }); await settle(); });
    },
    choose: async (id, value) => { await act(async () => {
      const field = node(id) as unknown as InstanceType<Window['HTMLInputElement']>;
      if (field.tagName === 'INPUT') {
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(field, value);
        field.dispatchEvent(new dom.Event('input', { bubbles: true }));
      } else {
        field.value = value;
        field.dispatchEvent(new dom.Event('change', { bubbles: true }));
      }
    }); },
    click: async id => { await act(async () => { (node(id) as unknown as HTMLElement).click(); await settle(); }); },
    text: id => node(id)?.textContent ?? '',
    value: id => (node(id) as unknown as HTMLInputElement)?.value,
    disabled: () => (node('button-submit-registration') as unknown as HTMLButtonElement).disabled,
    checked: () => (node('check-replace') as unknown as HTMLInputElement).checked,
  };
  try { await run(driver); }
  finally {
    await act(async () => root.unmount()); client.clear(); pinOrganizationIdForPage(null);
    globalThis.fetch = oldFetch; dom.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

for (const canManage of [true, false]) {
  test(`catalogue omits status panels while preserving content and controls (canManage=${canManage})`, async () => {
    const cat = snapshot();
    cat.canManage = canManage;
    cat.runtimeCapabilities = ['fixture.metadata.read'];
    cat.runtimeNotice = 'Fixture runtime notice that must not render';
    if (!canManage) {
      cat.registrations = []; cat.principals = []; cat.owners = [];
    }
    await fixture(async d => {
      await d.renderCatalogue();
      const section = d.dom.document.querySelector('[data-testid="section-catalogue"]')!;
      const text = section.textContent!;
      assert.equal(section.querySelector('#catalogue-h')?.textContent, 'Agent catalogue');
      assert.match(text, /Inspect reads saved definitions only; it never runs a model/);
      assert.doesNotMatch(text, /Registration is setup metadata only/);
      assert.match(text, /Product families are browsing labels/);
      assert.match(text, /Reviewed mappings associate coordination responsibilities only/);
      assert.doesNotMatch(text, /Runtime metadata read - implemented|Domain operational capabilities - unavailable|fixture\.metadata\.read|Fixture runtime notice|None reported|Effective access is not evaluated|Roles below describe intended responsibility|Fixture client - catalogue version/);
      assert.equal(section.querySelector('[data-testid="panel-runtime-implemented"]'), null);
      assert.equal(section.querySelector('[data-testid="panel-operational-unavailable"]'), null);
      assert.equal(d.text('catalogue-search-results'), '3 of 3 catalogue roles');
      assert.equal(section.querySelectorAll('[data-testid^="card-role-"]').length, 3);
      assert.equal(section.querySelectorAll('[data-testid^="button-inspect-"]').length, 3);
      assert.equal((text.match(/No role model executor/g) ?? []).length, 3);
      assert.equal(!!section.querySelector('[data-testid="form-register-agent"]'), canManage);
      assert.equal(!!section.querySelector('[data-testid="select-catalogue-role"]'), canManage);
      assert.equal(!!section.querySelector('[data-testid="button-submit-registration"]'), canManage);
      assert.equal(!!section.querySelector('[data-testid="notice-no-manage"]'), !canManage);
      assert.equal(section.querySelectorAll('[data-testid^="button-select-"]').length, canManage ? 3 : 0);
      if (canManage) {
        assert.equal(d.text('button-select-onboarding'), 'Replace');
        assert.equal(d.text('button-select-leave'), 'Register');
      } else {
        assert.equal((text.match(/Registration status private/g) ?? []).length, 3);
      }
    }, async () => new Response(JSON.stringify(cat), { headers: { 'Content-Type': 'application/json' } }));
  });
  test(`catalogue search preserves matching role cards without status panels (canManage=${canManage})`, async () => {
    const cat = { ...snapshot(), canManage };
    if (!canManage) {
      cat.registrations = []; cat.principals = []; cat.owners = [];
    }
    await fixture(async d => {
      await d.renderCatalogue('payroll');
      const section = d.dom.document.querySelector('[data-testid="section-catalogue"]')!;
      assert.equal(d.text('catalogue-search-results'), '1 of 3 catalogue roles match “payroll”');
      assert.equal(section.querySelectorAll('[data-testid^="card-role-"]').length, 1);
      assert.ok(section.querySelector('[data-testid="card-role-payroll"]'));
    }, async () => new Response(JSON.stringify(cat), { headers: { 'Content-Type': 'application/json' } }));
  });
}

test('bind initializes the current role and separates saved details from new-mode drafts', async () => {
  await fixture(async d => {
    await d.render(snapshot());
    await d.choose('input-principal-name', 'Unsaved new name');
    await d.choose('select-owner', 'owner-b');
    await d.click('radio-mode-bind');
    assert.equal(d.value('select-principal'), 'principal-a');
    assert.match(d.text('text-principal-detail'), /Saved Alpha.*principal-a.*Accountable Alpha.*active \/ 3/s);
    assert.doesNotMatch(d.text('text-principal-detail'), /Unsaved new name|Accountable Beta/);
    assert.match(d.text('current-principal-detail'), /Saved Alpha/);
    await d.choose('select-principal', 'principal-c');
    assert.match(d.text('text-principal-detail'), /Saved Gamma.*active \/ 2/s);
    assert.match(d.text('current-principal-detail'), /Saved Alpha/);
    await d.click('check-replace');
    assert.equal(d.disabled(), false);
    await d.choose('select-principal', 'principal-a');
    assert.equal(d.checked(), false);
    await d.click('radio-mode-new');
    assert.equal(d.value('input-principal-name'), 'Unsaved new name');
    assert.equal(d.value('select-owner'), 'owner-b');
  });
});

test('dropdown and repeated card navigation initialize registered roles and prompt for unregistered roles', async () => {
  await fixture(async d => {
    const cat = snapshot();
    await d.render(cat); await d.click('radio-mode-bind');
    await d.choose('select-principal', 'principal-c');
    await d.choose('select-catalogue-role', 'payroll');
    assert.equal(d.value('select-principal'), 'principal-b');
    assert.match(d.text('text-principal-detail'), /Saved Beta.*Accountable Beta.*active \/ 7/s);
    await d.choose('select-catalogue-role', 'leave');
    assert.equal(d.value('select-principal'), '');
    assert.equal(d.text('text-principal-detail'), '');
    assert.equal(d.disabled(), true);
    await d.render(cat, { key: 'onboarding', revision: 1 });
    assert.equal(d.value('select-principal'), 'principal-a');
    await d.choose('select-principal', 'principal-c');
    await d.render(cat, { key: 'onboarding', revision: 2 });
    assert.equal(d.value('select-principal'), 'principal-a');
    await d.render(cat, { key: 'leave', revision: 3 });
    assert.equal(d.value('select-principal'), '');
  });
});

test('unavailable, inactive, revoked, missing-owner and other-role candidates cannot submit', async () => {
  await fixture(async d => {
    const cat = snapshot();
    await d.render(cat); await d.click('radio-mode-bind');
    for (const [id, message] of [
      ['principal-retired', /retired/], ['principal-revoked', /revoked/],
      ['principal-orphan', /owner is unavailable/], ['principal-b', /another role \(payroll\)/],
    ] as const) {
      await d.choose('select-principal', id); await d.click('check-replace');
      assert.equal(d.disabled(), true);
      assert.match(d.text('alert-principal-blocked'), message);
    }
    const missing = snapshot(); missing.principals = missing.principals.filter(p => p.id !== 'principal-a');
    await d.render(missing, { key: 'onboarding', revision: 1 });
    assert.equal(d.value('select-principal'), 'principal-a');
    assert.match(d.text('current-principal-detail'), /Unavailable in this client snapshot/);
    assert.match(d.text('alert-principal-blocked'), /unavailable in the current client/);
    assert.equal(d.disabled(), true);
  });
});

test('directory failures use honest identity labels without inventing a name or rejecting eligible membership', async () => {
  await fixture(async d => {
    const cat = snapshot();
    cat.owners[0] = { ...cat.owners[0], name: null, email: null, identityResolution: 'unavailable' };
    await d.render(cat); await d.click('radio-mode-bind'); await d.click('check-replace');
    assert.match(d.text('text-principal-detail'), /Directory unavailable.*Directory profile unavailable/s);
    assert.equal(d.disabled(), false);
  });
});

test('refresh preserves explicit selection, updates saved data, and invalidates only relevant review evidence', async () => {
  await fixture(async d => {
    const cat = snapshot();
    await d.render(cat); await d.click('radio-mode-bind'); await d.choose('select-principal', 'principal-c');
    await d.click('check-replace');
    const unrelated = structuredClone(cat); unrelated.principals[1].name = 'Unrelated rename';
    await d.render(unrelated);
    assert.equal(d.value('select-principal'), 'principal-c'); assert.equal(d.checked(), true);
    const changed = structuredClone(unrelated);
    changed.principals[2] = { ...changed.principals[2], name: 'Updated Gamma', ownerUserId: 'owner-b', version: 9 };
    await d.render(changed);
    assert.equal(d.value('select-principal'), 'principal-c');
    assert.match(d.text('text-principal-detail'), /Updated Gamma.*Accountable Beta.*active \/ 9/s);
    assert.equal(d.checked(), false); assert.equal(d.disabled(), true);
    assert.match(d.text('alert-review-required'), /saved information changed/);
    await d.click('check-replace'); assert.equal(d.disabled(), false);
    const ownerChanged = structuredClone(changed); ownerChanged.owners[1].name = 'Updated owner';
    await d.render(ownerChanged); assert.equal(d.checked(), false);
    const removed = structuredClone(ownerChanged); removed.principals.splice(2, 1);
    await d.render(removed);
    assert.equal(d.value('select-principal'), 'principal-c');
    assert.match(d.text('text-principal-detail'), /Unavailable/); assert.equal(d.disabled(), true);
  });
});

test('unregistered refreshed selection requires renewed review and automatic binding follows current saved records', async () => {
  await fixture(async d => {
    const cat = snapshot();
    await d.render(cat); await d.click('radio-mode-bind');
    const changedBinding = structuredClone(cat); changedBinding.registrations[0].agentId = 'principal-c';
    await d.render(changedBinding);
    assert.equal(d.value('select-principal'), 'principal-c');
    assert.equal(d.checked(), false);
    await d.choose('select-catalogue-role', 'leave'); await d.choose('select-principal', 'principal-c');
    // This is still bound to onboarding and therefore not eligible.
    assert.equal(d.disabled(), true);
    const unbound = structuredClone(changedBinding); unbound.registrations = [];
    await d.render(unbound); assert.equal(d.disabled(), true);
    await d.click('button-review-details'); assert.equal(d.disabled(), false);
  });
});

test('unknown retries stay identical through refresh, reload and attempted card navigation', async () => {
  const posts: string[] = [];
  await fixture(async d => {
    const cat = snapshot();
    await d.render(cat); await d.click('radio-mode-bind'); await d.choose('select-principal', 'principal-c');
    await d.click('check-replace'); await d.click('button-submit-registration');
    assert.match(d.text('notice-unknown'), /identical request/);
    const changed = structuredClone(cat); changed.principals[2].version = 88;
    changed.registrations[0].agentId = 'principal-b';
    await d.render(changed, { key: 'leave', revision: 1 });
    assert.equal(d.value('select-catalogue-role'), 'onboarding');
    assert.equal(d.value('select-principal'), 'principal-c');
    await d.click('button-reload-catalogue'); await d.click('button-submit-registration');
    assert.equal(posts.length, 2); assert.equal(posts[0], posts[1]);
    const payload = JSON.parse(posts[0]);
    assert.equal(payload.expectedPrincipalVersion, 2);
    assert.equal(payload.expectedBindingVersion, 2);
    assert.equal(payload.ownerUserId, 'owner-a');
    assert.ok(payload.requestId);
  }, async (_url, init) => { posts.push(String(init?.body)); throw new Error('Fixture lost response'); });
});

test('changing session scope discards all prior selections and pending retries', async () => {
  await fixture(async d => {
    await d.render(snapshot()); await d.click('radio-mode-bind');
    await d.choose('select-principal', 'principal-c'); await d.click('check-replace');
    await d.click('button-submit-registration');
    assert.match(d.text('notice-unknown'), /unknown/);
    await d.render(snapshot(), undefined, 'session-b');
    assert.equal(d.text('notice-unknown'), '');
    assert.equal(d.value('input-principal-name'), '');
    await d.click('radio-mode-bind');
    assert.equal(d.value('select-principal'), 'principal-a'); assert.equal(d.checked(), false);
  }, async () => { throw new Error('Lost response'); });
});

test('catalogue cards navigate, normal refresh preserves the form, and read errors remove private DOM without losing identical retry', async () => {
  let cat = snapshot(), readError = false;
  const posts: string[] = [];
  await fixture(async d => {
    await d.renderCatalogue(); await d.click('radio-mode-bind');
    await d.click('button-select-payroll');
    assert.equal(d.value('select-principal'), 'principal-b');
    await d.click('button-select-leave');
    assert.equal(d.value('select-principal'), '');
    await d.click('button-select-onboarding');
    await d.choose('select-principal', 'principal-c'); await d.click('check-replace');
    const form = d.dom.document.querySelector('[data-testid="form-register-agent"]');
    cat = structuredClone(cat); cat.principals[2].name = 'Refreshed Gamma';
    await d.refreshCatalogue();
    assert.equal(d.dom.document.querySelector('[data-testid="form-register-agent"]'), form);
    assert.equal(d.value('select-principal'), 'principal-c');
    assert.match(d.text('text-principal-detail'), /Refreshed Gamma/);
    assert.equal(d.checked(), false);
    await d.click('check-replace'); await d.click('button-submit-registration');
    readError = true; await d.refreshCatalogue();
    assert.match(d.text('error-catalogue'), /could not be loaded/);
    assert.equal(d.dom.document.querySelector('[data-testid="form-register-agent"]'), null);
    assert.doesNotMatch(d.dom.document.body.textContent!, /Saved Alpha|Refreshed Gamma|Accountable Alpha/);
    readError = false; cat.principals[2].version = 11;
    await d.click('button-retry-catalogue');
    assert.notEqual(d.dom.document.querySelector('[data-testid="form-register-agent"]'), form);
    assert.equal(d.value('select-principal'), 'principal-c');
    await d.click('button-submit-registration');
    assert.equal(posts.length, 2); assert.equal(posts[0], posts[1]);
  }, async (_url, init) => {
    if (init?.method === 'POST') { posts.push(String(init.body)); throw new Error('Lost outcome'); }
    if (readError) return new Response(JSON.stringify({ message: 'Fixture unavailable' }), { status: 503 });
    return new Response(JSON.stringify(cat), { headers: { 'Content-Type': 'application/json' } });
  });
});

for (const denial of [401, 403]) {
  test(`denied catalogue refresh (${denial}) removes private DOM, cached snapshot and unresolved request`, async () => {
    let status = 200;
    await fixture(async d => {
      await d.renderCatalogue(); await d.click('radio-mode-bind');
      await d.choose('select-principal', 'principal-c'); await d.click('check-replace');
      await d.click('button-submit-registration');
      assert.match(d.text('notice-unknown'), /unknown/);
      status = denial; await d.refreshCatalogue();
      assert.equal(d.dom.document.querySelector('[data-testid="form-register-agent"]'), null);
      assert.doesNotMatch(d.dom.document.body.textContent!, /Saved Alpha|Saved Gamma|Accountable Alpha|principal-c/);
      assert.equal(d.client.getQueryData(['agent-catalogue', 'fixture-admin', '', 'client-a']), undefined);
      status = 200; await d.click('button-retry-catalogue');
      assert.equal(d.text('notice-unknown'), '');
      assert.equal(d.value('input-principal-name'), '');
    }, async (_url, init) => {
      if (init?.method === 'POST') throw new Error('Lost outcome');
      return new Response(JSON.stringify(status === 200 ? snapshot() : { message: 'Current access denied' }), {
        status, headers: { 'Content-Type': 'application/json' },
      });
    });
  });
}

test('a successful non-manager snapshot clears the unresolved administrative request', async () => {
  let cat = snapshot();
  await fixture(async d => {
    await d.renderCatalogue(); await d.click('radio-mode-bind');
    await d.click('check-replace'); await d.click('button-submit-registration');
    assert.match(d.text('notice-unknown'), /unknown/);
    cat = { ...snapshot(), canManage: false, registrations: [], principals: [], owners: [] };
    await d.refreshCatalogue();
    assert.equal(d.dom.document.querySelector('[data-testid="form-register-agent"]'), null);
    assert.doesNotMatch(d.dom.document.body.textContent!, /Saved Alpha|Accountable Alpha|principal-a/);
    cat = snapshot(); await d.refreshCatalogue();
    assert.equal(d.text('notice-unknown'), '');
    assert.equal(d.value('input-principal-name'), '');
  }, async (_url, init) => {
    if (init?.method === 'POST') throw new Error('Lost outcome');
    return new Response(JSON.stringify(cat), { headers: { 'Content-Type': 'application/json' } });
  });
});

function inspectableSnapshot(): AgentCatalogue {
  const cat = snapshot();
  cat.entries[0].inspection = {
    execution: 'No role executor; independent workflow only.',
    instructions: 'Actual static operating contract.',
    workflows: [{
      name: 'Linked plan workflow', association: 'Independent component, not a role executor',
      source: 'shared-server-definition.ts', hash: 'fixture-sha256', system: 'Static system instruction',
      template: 'Context: {{authorized_evidence}}', provider: 'OpenAI', model: 'gpt-5-nano',
      settings: 'max_completion_tokens=3200', status: 'Implemented gated path',
    }],
    tools: [{ name: 'tool.case.read', input: 'caseId', output: 'lifecycleStage', access: 'Current accountable owner', association: 'Shared principal tool' }],
    contextSources: ['Authorized metadata'], protocols: [
      { name: 'A2A', status: 'Not implemented', description: 'Agent-to-agent interoperability' },
      { name: 'MCP', status: 'Not implemented', description: 'Model-to-tool/context interoperability' },
    ], collaborations: ['Proposed design metadata only'], unavailable: ['Token spend', 'Deployment'],
  };
  cat.legacyIdentities = ['documentation', 'access', 'assets', 'payroll', 'learning'].map(id => ({
    id, name: `Historical ${id}`, description: 'Legacy identity; not a registered role executor.',
    owner: 'Historical team label', capabilities: ['Track handoffs'],
  }));
  cat.activity = [
    { id: 1, agentId: 'principal-a', agentVersion: 3, toolKey: 'tool.case.read', action: 'case.metadata.read',
      outcome: 'success', createdAt: '2026-10-01T10:00:00.000Z', runId: 'exact-run', correlationId: 'exact-correlation' },
    { id: 2, agentId: 'principal-a', agentVersion: 2, toolKey: 'tool.context.read', action: 'case.context.read',
      outcome: 'denied', createdAt: '2026-10-01T09:00:00.000Z', runId: 'old-version-run', correlationId: 'old-correlation' },
    { id: 3, agentId: 'principal-b', agentVersion: 7, toolKey: 'tool.case.read', action: 'case.metadata.read',
      outcome: 'success', createdAt: '2026-10-01T09:00:00.000Z', runId: 'other-agent-run', correlationId: 'other-correlation' },
  ];
  return cat;
}

test('inspector reads shared static definitions, copies templates, and only shows attributable tool activity', async () => {
  let reads = 0, copied = '';
  await fixture(async d => {
    Object.defineProperty(d.dom.navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied = text; } } });
    await d.renderCatalogue();
    await d.click('button-inspect-onboarding');
    const dialog = () => d.dom.document.querySelector('[role="dialog"]')!;
    assert.match(dialog().textContent!, /Saved Alpha/);
    assert.equal(d.dom.document.activeElement?.id, 'insp-title');
    await d.click('tab-inspector-1');
    assert.match(dialog().textContent!, /Static system instruction/);
    assert.match(dialog().textContent!, /Context: \{\{authorized_evidence\}\}/);
    assert.match(dialog().textContent!, /fixture-sha256/);
    await d.click('button-copy-template-onboarding-0');
    assert.equal(copied, 'Context: {{authorized_evidence}}');
    assert.match(dialog().textContent!, /Copied/);
    await d.click('tab-inspector-2');
    assert.match(dialog().textContent!, /OpenAI \/ gpt-5-nano/);
    await d.click('tab-inspector-3');
    assert.match(dialog().textContent!, /A2A.*Not implemented.*MCP.*Not implemented/s);
    assert.doesNotMatch(dialog().textContent!, /Connected/);
    await d.click('tab-inspector-4');
    assert.match(dialog().textContent!, /exact-run.*exact-correlation/s);
    assert.doesNotMatch(dialog().textContent!, /old-version-run|other-agent-run/);
    assert.match(dialog().textContent!, /not inference telemetry/);
    await d.click('button-close-inspector');
    assert.equal(dialog(), null);
    // Programmatic click does not move focus; browser tests cover opener focus.
    assert.equal(reads, 1, 'inspection must not send any model, tool or effect request');
  }, async (_url, init) => {
    assert.ok(!init?.method || init.method === 'GET');
    reads++;
    return new Response(JSON.stringify(inspectableSnapshot()), { headers: { 'Content-Type': 'application/json' } });
  });
});

test('legacy links keep colliding role names distinct and search does not manufacture mappings', async () => {
  await fixture(async d => {
    d.dom.history.replaceState(null, '', '#payroll');
    await d.renderCatalogue();
    assert.equal(d.dom.document.querySelector('[role="dialog"]'), null);
    assert.match(d.text('legacy-payroll'), /Historical payroll.*Historical team label/s);
    assert.equal(d.dom.document.querySelector('[data-testid="legacy-references"]')?.getAttribute('open'), '');
    assert.match(d.text('legacy-references'), /nothing here maps to a role, principal or executor/);
    await d.renderCatalogue('Historical payroll');
    assert.equal(d.dom.document.querySelectorAll('[data-testid^="card-role-"]').length, 0);
    assert.match(d.text('legacy-payroll'), /Historical payroll/);
    await act(async () => {
      d.dom.history.replaceState(null, '', '#role:payroll');
      d.dom.window.dispatchEvent(new d.dom.Event('hashchange'));
      await settle();
    });
    await d.renderCatalogue();
    assert.ok(d.dom.document.querySelector('[data-testid="inspector-payroll"]'));
  }, async () => new Response(JSON.stringify(inspectableSnapshot()), { headers: { 'Content-Type': 'application/json' } }));
});

test('read failure and administrative loss remove inspector private state before retry', async () => {
  let cat = inspectableSnapshot(), fail = false;
  await fixture(async d => {
    await d.renderCatalogue(); await d.click('button-inspect-onboarding'); await d.click('tab-inspector-4');
    assert.match(d.dom.document.body.textContent!, /exact-correlation/);
    fail = true; await d.refreshCatalogue();
    assert.equal(d.dom.document.querySelector('[role="dialog"]'), null);
    assert.doesNotMatch(d.dom.document.body.textContent!, /exact-correlation|Saved Alpha/);
    fail = false; cat = { ...cat, canManage: false, principals: [], registrations: [], owners: [], activity: [] };
    await d.click('button-retry-catalogue');
    await d.click('button-inspect-onboarding'); await d.click('tab-inspector-4');
    assert.match(d.dom.document.body.textContent!, /Activity is private/);
    assert.doesNotMatch(d.dom.document.body.textContent!, /exact-correlation|Saved Alpha/);
  }, async () => new Response(JSON.stringify(fail ? { message: 'Unavailable' } : cat), {
    status: fail ? 503 : 200, headers: { 'Content-Type': 'application/json' },
  }));
});

test('late prior-tenant response cannot restore private catalogue or inspector after session switch', async () => {
  let release: ((response: Response) => void) | undefined, calls = 0;
  await fixture(async d => {
    await d.renderCatalogue('', { userId: 'old-user', sessionId: 'old-session', orgId: 'client-a' });
    assert.ok(d.dom.document.querySelector('[data-testid="loading-catalogue"]'));
    await d.renderCatalogue('', { userId: 'new-user', sessionId: 'new-session', orgId: 'client-b' });
    assert.match(d.text('notice-no-manage'), /private to administrators/);
    await act(async () => {
      release!(new Response(JSON.stringify(inspectableSnapshot()), { headers: { 'Content-Type': 'application/json' } }));
      await settle();
    });
    assert.doesNotMatch(d.dom.document.body.textContent!, /Saved Alpha|Accountable Alpha|exact-correlation/);
    assert.equal(d.dom.document.querySelector('[data-testid="form-register-agent"]'), null);
    assert.equal(d.dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(d.client.getQueryData(['agent-catalogue', 'old-user', 'old-session', 'client-a']), undefined);
  }, async () => {
    calls++;
    if (calls === 1) return new Promise<Response>(resolve => { release = resolve; });
    const cat = { ...inspectableSnapshot(), organizationId: 'client-b', canManage: false, principals: [], registrations: [], owners: [], activity: [] };
    return new Response(JSON.stringify(cat), { headers: { 'Content-Type': 'application/json' } });
  });
});

test('live administrative loss redacts an already-open inspector and family filters remain usable', async () => {
  let cat = inspectableSnapshot();
  cat.entries[0].productFamilies = ['Onboarding'];
  cat.entries[1].productFamilies = ['Payroll'];
  await fixture(async d => {
    await d.renderCatalogue();
    await d.choose('select-family-filter', 'Payroll');
    assert.equal(d.dom.document.querySelectorAll('[data-testid^="card-role-"]').length, 1);
    await d.choose('select-family-filter', '');
    await d.click('button-inspect-onboarding');
    assert.match(d.dom.document.body.textContent!, /Saved Alpha/);
    cat = { ...cat, canManage: false, registrations: [], principals: [], owners: [], activity: [] };
    await d.refreshCatalogue();
    assert.doesNotMatch(d.dom.document.body.textContent!, /Saved Alpha|Accountable Alpha|principal-a/);
    assert.match(d.dom.document.querySelector('[role="dialog"]')!.textContent!, /Binding details are private/);
    await d.click('tab-inspector-4');
    assert.match(d.dom.document.querySelector('[role="dialog"]')!.textContent!, /Activity is private/);
  }, async () => new Response(JSON.stringify(cat), { headers: { 'Content-Type': 'application/json' } }));
});
