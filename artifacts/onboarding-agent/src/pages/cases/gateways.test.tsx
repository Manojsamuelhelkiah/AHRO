import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { GatewaysStrip } from './detail/gateways-strip';
import { CompactGates, NewCaseForm } from './index';
import { ONBOARDING_STAGE_NAMES, lifecycleStageText, stageStatusText } from '../../lib/lifecycle-stage-presentation';
import { CaseAccessProvider } from './detail/case-access';

test('GatewaysStrip renders all three gates and only exposes Gate A after scoped authority preflight', () => {
  const mockCase = {
    id: 1,
    offerAcceptanceComplete: false,
    orchestrationStatus: 'not-ready',
    gateways: {
      a: { status: 'pending' as const, label: 'A Label', reason: 'A Reason' },
      b: { status: 'human-review' as const, label: 'B Label', reason: 'B Reason' },
      c: { status: 'blocked' as const, label: 'C Label', reason: 'C Reason' },
    }
  };

  const dummyHook = () => ['/cases/1', () => {}] as [string, (path: string) => void];
  const gateApproval = { id: 44, version: 1, status: 'pending' };

  const render = (canDecide: boolean, canEditIdentity = true) => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['/api/onboarding/approvals', gateApproval.id, 'capability', gateApproval.version, null],
      { canDecide, reason: canDecide ? null : 'no_current_verified_scoped_assignment', version: 1 },
    );
    return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Router hook={dummyHook}>
        <CaseAccessProvider value={{
          caseId: 1,
          access: { flowRead: true, profileRead: true, profileEdit: true, notesRead: true, notesEdit: true, flowEdit: true },
          sensitive: { identity: { read: true, edit: canEditIdentity }, medical: { read: false, edit: false },
            payroll: { read: false, edit: false }, bgv: { read: false, edit: false } },
        }}>
          <GatewaysStrip c={mockCase} gateApproval={gateApproval} />
        </CaseAccessProvider>
      </Router>
    </QueryClientProvider>
    );
  };

  const htmlAuthority = render(true);
  for (const name of Object.values(ONBOARDING_STAGE_NAMES)) assert.match(htmlAuthority, new RegExp(name));
  for (const status of ['Pending', 'Human Review', 'Blocked']) assert.match(htmlAuthority, new RegExp(status, 'i'));
  assert.doesNotMatch(htmlAuthority, /Gateway [ABC]|Gate [ABC]|>A<|>B<|>C</);
  
  assert.match(htmlAuthority, /A Reason/);
  assert.match(htmlAuthority, /B Reason/);
  assert.match(htmlAuthority, /C Reason/);
  assert.match(htmlAuthority, /View Pending Interventions/);
  assert.match(htmlAuthority, /Exceptions and blocked outcomes require human review/);
  assert.match(htmlAuthority, /Confirm Offer-Acceptance Package/);

  const htmlDenied = render(false);
  assert.doesNotMatch(htmlDenied, /Confirm Offer-Acceptance Package/, 'Unscoped browser roles must not reveal the confirmation control');
  assert.doesNotMatch(render(true, false), /Confirm Offer Package/, 'Approval authority alone cannot bypass sensitive case permissions');
});

test('business-stage labels preserve every status and blocked reason in list and detail', () => {
  for (const status of ['pending', 'human-review', 'blocked', 'complete', 'not-applicable'] as const) {
    const gateways = {
      a: { status, label: 'Gate A — offer acceptance', reason: 'Required evidence is missing' },
      b: { status, label: 'Gate B — background verification', reason: 'Current source status' },
      c: { status, label: 'Gate C — Day-1 readiness', reason: 'Current readiness evidence' },
    };
    const listHtml = renderToStaticMarkup(<CompactGates gateways={gateways} />);
    const detailHtml = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <Router hook={() => ['/cases/1', () => {}]}>
          <GatewaysStrip c={{ id: 1, gateways, offerAcceptanceComplete: false, orchestrationStatus: 'idle' }} />
        </Router>
      </QueryClientProvider>,
    );
    for (const html of [listHtml, detailHtml]) {
      for (const name of Object.values(ONBOARDING_STAGE_NAMES)) assert.ok(html.includes(name));
      assert.match(html, new RegExp(stageStatusText(status), 'i'));
      assert.match(html, /Required evidence is missing/);
      assert.doesNotMatch(html, /Gateway [ABC]|Gate [ABC]|>A<|>B<|>C</);
      if (status !== 'complete') assert.doesNotMatch(html, />Complete</);
    }
  }
});

test('display mappings leave stored identifiers and genuine infrastructure wording intact', () => {
  const ruleRef = 'Gate A — offer-acceptance package';
  assert.equal(lifecycleStageText(ruleRef), 'Offer-Acceptance Package');
  assert.equal(ruleRef, 'Gate A — offer-acceptance package');
  assert.equal(lifecycleStageText('Gate C Day-1 readiness confirmed by HR'), 'Day-1 Readiness confirmed by HR');
  const infrastructure = 'API Gateway, AI Gateway, and generic BPMN gateway notation';
  assert.equal(lifecycleStageText(infrastructure), infrastructure);
  assert.equal(lifecycleStageText('Gate B — background verification'), 'Background Checks');
});

test('NewCaseForm does not permit bypassing dedicated Gate A confirmation', () => {
  const queryClient = new QueryClient();
  const dummyHook = () => ['/cases', () => {}] as [string, (path: string) => void];

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Router hook={dummyHook}>
        <NewCaseForm onClose={() => {}} />
      </Router>
    </QueryClientProvider>
  );
  
  assert.doesNotMatch(html, /name="offerAcceptanceComplete"/);
});