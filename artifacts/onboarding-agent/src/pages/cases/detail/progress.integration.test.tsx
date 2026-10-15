import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage, getListOnboardingCaseEventsQueryKey } from '@workspace/api-client-react';
import { useCaseHistory } from './use-case-history';
import { ProgressHistory } from './progress-history';
import type { CaseAccessPermissions } from './case-access';
import { CaseAccessProvider } from './case-access';
import { TransactionContextTab } from './transaction-context-tab';
import { ProgressTab } from './progress-tab';
import { CaseTabs } from './components';
import { caseDestinationFromSearch, caseSectionSearch } from './progress-navigation';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function waitFor(predicate: () => boolean, description: string) {
  for (let i = 0; i < 80; i++) {
    if (predicate()) return;
    await act(tick);
  }
  assert.fail(`Timed out waiting for ${description}`);
}
function permissions(caseId: number, notesRead: boolean, flowRead = true): CaseAccessPermissions {
  return { caseId, access: { flowRead, notesRead, flowEdit: false, profileRead: true, profileEdit: false, notesEdit: false },
    sensitive: Object.fromEntries(['identity', 'medical', 'payroll', 'bgv'].map(key => [key, { read: false, edit: false }])) as CaseAccessPermissions['sensitive'] };
}
function Harness({ caseId, org, user, access, permissionError = false }: {
  caseId: number; org: string; user: string; access: CaseAccessPermissions; permissionError?: boolean;
}) {
  const history = useCaseHistory(caseId, org, user, access, permissionError, 'done');
  return <><p>Authorized current work remains visible</p><ProgressHistory {...history} /></>;
}

test('history uses real query boundaries through expansion, errors, permission loss, late responses and case/principal changes', async () => {
  const dom = new Window({ url: 'http://localhost/cases/1?tab=progress' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver',
    'fetch', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names.filter(name => name !== 'fetch' && name !== 'IS_REACT_ACT_ENVIRONMENT')) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom as any)[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true, writable: true });
  const client = new QueryClient();
  const root = createRoot(document.body);
  const requests: { path: string; org: string | null }[] = [];
  let marker = 'scope-a';
  let mode: 'normal' | 'hold' | 'empty' | 'fail' = 'normal';
  const releases: (() => void)[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    assert.match(path, /\/api\/onboarding\/cases\/\d+\/events$/);
    requests.push({ path, org: new Headers(init?.headers).get('x-organization-id') });
    const body = Array.from({ length: 23 }, (_, i) => ({
      id: i + 1, caseId: Number(path.match(/cases\/(\d+)/)?.[1]), title: `${marker}-event-${i + 1}`,
      detail: `${marker}-detail`, agent: 'Named human reviewer', engine: 'human',
      createdAt: `2026-10-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    }));
    const capturedMode = mode;
    if (capturedMode === 'hold') await new Promise<void>(resolve => releases.push(resolve));
    return new Response(JSON.stringify(capturedMode === 'empty' ? [] : capturedMode === 'fail' ? { message: 'Read denied' } : body),
      { status: capturedMode === 'fail' ? 403 : 200, headers: { 'content-type': 'application/json' } });
  };
  const render = async (caseId = 1, notes = true, org = 'client-a', user = 'viewer-a', flow = true, permissionError = false) => {
    pinOrganizationIdForPage(org);
    await act(async () => {
      root.render(<QueryClientProvider client={client}><Harness caseId={caseId} org={org} user={user}
        access={permissions(caseId, notes, flow)} permissionError={permissionError} /></QueryClientProvider>);
      await tick();
    });
  };
  const text = () => document.body.textContent || '';
  const older = () => [...document.querySelectorAll('button')].find(b => b.textContent?.startsWith('Show older'))!;
  try {
    await render(1, false);
    assert.equal(requests.length, 0, 'no notes-read, no history fetch');
    assert.match(text(), /restricted/);
    assert.match(text(), /Authorized current work/);
    await render(1, true, 'client-a', 'viewer-a', false);
    assert.equal(requests.length, 0, 'no flow-read, no history fetch');
    await render(1, true, 'client-a', 'viewer-a', true, true);
    assert.equal(requests.length, 0, 'failed permission observation denies reads');

    await render();
    await waitFor(() => text().includes('Showing 10 of 23'), 'initial events');
    assert.equal(document.querySelector('li')?.getAttribute('data-event-id'), '23');
    assert.equal(document.querySelectorAll('li').length, 10);
    assert.match(text(), /Named human reviewer/);
    assert.equal(requests.at(-1)?.org, 'client-a');
    assert.equal(older().getAttribute('aria-controls'), 'progress-history-events');
    older().focus();
    assert.equal(document.activeElement, older(), 'native control is focusable');
    await act(async () => { older().click(); await tick(); });
    assert.equal(document.querySelectorAll('li').length, 20);
    await act(async () => { older().click(); await tick(); });
    assert.equal(document.querySelectorAll('li').length, 23);
    assert.match(text(), /scope-a-event-1/);

    // A denied refetch must hide retained successful query data immediately.
    mode = 'fail';
    await act(async () => { await client.refetchQueries({ queryKey: getListOnboardingCaseEventsQueryKey(1) }); });
    await waitFor(() => text().includes('could not be loaded'), 'denied refetch');
    assert.doesNotMatch(text(), /scope-a/);
    mode = 'normal';
    await act(async () => { document.querySelector('button')!.click(); await tick(); });
    await waitFor(() => text().includes('scope-a'), 'retry recovery');
    // Revocation hides data and clears its scoped cache.
    const count = requests.length;
    await render(1, false);
    assert.match(text(), /restricted/);
    assert.doesNotMatch(text(), /scope-a/);
    assert.equal(requests.length, count);
    assert.equal(client.getQueryCache().findAll({ queryKey: getListOnboardingCaseEventsQueryKey(1) })
      .filter(q => q.state.data !== undefined).length, 0);

    mode = 'hold';
    marker = 'late-private';
    await render();
    await waitFor(() => releases.length > 0, 'held request');
    assert.match(text(), /Loading recorded history/);
    await render(1, false);
    await act(async () => { releases.splice(0).forEach(release => release()); await tick(); });
    assert.doesNotMatch(text(), /late-private/);
    assert.match(text(), /restricted/);

    mode = 'normal';
    marker = 'scope-b';
    await render(2, true, 'client-b', 'viewer-b');
    await waitFor(() => text().includes('scope-b'), 'new scope');
    assert.equal(document.querySelectorAll('li').length, 10, 'expansion resets on scope change');
    assert.doesNotMatch(text(), /scope-a|late-private/);
    assert.equal(requests.at(-1)?.org, 'client-b');
    // Even the same case cannot carry data between viewers or organizations.
    mode = 'hold';
    marker = 'new-viewer';
    await render(2, true, 'client-b', 'viewer-c');
    assert.doesNotMatch(text(), /scope-b/);
    await waitFor(() => releases.length > 0, 'new viewer request');
    mode = 'empty';
    await render(3, true, 'client-c', 'viewer-c');
    await waitFor(() => text().includes('No recorded events yet'), 'genuine empty state');
    await act(async () => { releases.splice(0).forEach(release => release()); await tick(); });
    assert.doesNotMatch(text(), /new-viewer|scope-b/);
    assert.match(text(), /No recorded events yet/);
  } finally {
    await act(async () => { releases.splice(0).forEach(release => release()); root.unmount(); client.clear(); await tick(); });
    pinOrganizationIdForPage(null);
    await dom.happyDOM.close();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('selecting every CaseTabs button round-trips its URL and Progress section without dropping existing context', async () => {
  const dom = new Window({ url: 'http://localhost/cases/1?keep=review#source' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver',
    'IS_REACT_ACT_ENVIRONMENT'] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names.filter(name => name !== 'IS_REACT_ACT_ENVIRONMENT')) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom as any)[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true, writable: true });
  const root = createRoot(document.body);
  function NavigationHarness() {
    const [search, setSearch] = React.useState(window.location.search);
    const destination = caseDestinationFromSearch(search);
    const setActiveTab = (tab: string, section?: string) => {
      const next = caseSectionSearch(search, tab, section);
      window.history.pushState(null, '', `${window.location.pathname}${next}${window.location.hash}`);
      setSearch(next);
    };
    return <CaseAccessProvider value={permissions(1, true)}>
      <CaseTabs activeTab={destination.tab} setTab={setActiveTab} />
      <output>{destination.tab}:{destination.section || ''}</output>
      <button onClick={() => setActiveTab('Progress', 'current-work')}>Open current work</button>
      <button onClick={() => setActiveTab('Progress', 'history')}>Open history</button>
    </CaseAccessProvider>;
  }
  const click = async (label: string) => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(button, label);
    await act(async () => { button.click(); await tick(); });
  };
  try {
    await act(async () => { root.render(<NavigationHarness />); await tick(); });
    for (const tab of ['Overview', 'Early tenure', 'Progress', 'Frontline', 'Documents', 'Communications',
      'Audit', 'Transaction context', 'Ask AI']) {
      await click(tab);
      assert.equal(document.querySelector('[aria-current="page"]')?.textContent, tab);
      assert.equal(caseDestinationFromSearch(window.location.search).tab, tab);
      assert.equal(new URLSearchParams(window.location.search).get('keep'), 'review');
      assert.equal(window.location.hash, '#source');
    }
    await click('Open history');
    assert.equal(document.querySelector('output')?.textContent, 'Progress:history');
    await click('Open current work');
    assert.equal(document.querySelector('output')?.textContent, 'Progress:current-work');
  } finally {
    await act(async () => { root.unmount(); await tick(); });
    await dom.happyDOM.close();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('transaction sources open the correct Progress section and notes restrictions keep current-work links available', async () => {
  const dom = new Window({ url: 'http://localhost/cases/1?tab=context' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver',
    'fetch', 'IS_REACT_ACT_ENVIRONMENT'] as const;
  const originals = new Map<string, PropertyDescriptor | undefined>(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names.filter(name => name !== 'fetch' && name !== 'IS_REACT_ACT_ENVIRONMENT')) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: (dom as any)[name] });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true, writable: true });
  const client = new QueryClient();
  const root = createRoot(document.body);
  const opened: (string | undefined)[][] = [];
  globalThis.fetch = async (input) => {
    assert.match(String(input), /transaction-context/);
    return new Response(JSON.stringify({
      workflow: 'onboarding', transactionId: 'case-1', asOf: '2026-10-01T00:00:00Z',
      sourceRevision: 'one', summaryVersion: 1, summary: [], annotations: [], limitations: [], canAnnotate: false,
      sources: [
        { id: 'work', tab: 'tasks', section: 'pending', label: 'Current planned work', text: 'Plan evidence', revision: 1, provenance: 'case' },
        { id: 'recorded', tab: 'activity', section: 'completed', label: 'Recorded source', text: 'Event evidence', revision: 1, provenance: 'case' },
      ],
    }), { headers: { 'content-type': 'application/json' } });
  };
  const render = async (notesRead: boolean) => {
    await act(async () => {
      root.render(<QueryClientProvider client={client}><CaseAccessProvider value={permissions(1, notesRead)}>
        <TransactionContextTab caseId={1} availableTabs={['Overview', 'Progress']}
          setTab={(tab, section) => opened.push([tab, section])} />
      </CaseAccessProvider></QueryClientProvider>);
      await tick();
    });
  };
  const link = (text: string) => [...document.querySelectorAll('button')].find(button => button.textContent?.includes(text));
  try {
    await render(true);
    await waitFor(() => !!link('Progress history'), 'transaction links');
    await act(async () => { link('Progress current work')!.click(); link('Progress history')!.click(); });
    assert.deepEqual(opened, [['Progress', 'current-work'], ['Progress', 'history']]);
    await render(false);
    await waitFor(() => !!link('Progress current work'), 'restricted transaction sources');
    assert.equal(link('Progress history'), undefined);
    await act(async () => { link('Progress current work')!.click(); });
    assert.deepEqual(opened.at(-1), ['Progress', 'current-work']);

    // Ordinary current work is also mounted client-side, not only server-rendered.
    // Empty history must not erase its completed/rejected workstreams.
    await act(async () => {
      root.render(<CaseAccessProvider value={permissions(1, false)}><ProgressTab
        c={{ planSummary: 'Ordinary plan', workstreams: [
          { key: 'done', label: 'Ordinary completed work', status: 'completed', agent: 'Records Agent', owner: 'Reviewer' },
          { key: 'rejected', label: 'Ordinary rejected work', status: 'rejected', agent: 'Records Agent', owner: 'Reviewer' },
        ] }} pendingApprovals={[]}
        history={{ scope: 'ordinary', allowed: false, loading: false, failed: false, retry: () => {} }} /></CaseAccessProvider>);
      await tick();
    });
    assert.match(document.body.textContent || '', /Ordinary plan/);
    assert.match(document.body.textContent || '', /Ordinary completed work/);
    assert.match(document.body.textContent || '', /Ordinary rejected work/);
    assert.match(document.body.textContent || '', /history is restricted/);
  } finally {
    await act(async () => { root.unmount(); client.clear(); await tick(); });
    await dom.happyDOM.close();
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(globalThis, name, original);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
