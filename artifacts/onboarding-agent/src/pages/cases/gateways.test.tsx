import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { GatewaysStrip } from './detail/gateways-strip';
import { NewCaseForm } from './index';
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
  
  assert.match(htmlAuthority, /A Label/);
  assert.match(htmlAuthority, /B Label/);
  assert.match(htmlAuthority, /C Label/);
  assert.match(htmlAuthority, /View Pending Interventions/);
  assert.match(htmlAuthority, /Exceptions and blocked outcomes require human review/);
  assert.match(htmlAuthority, /Confirm Offer Package/);

  const htmlDenied = render(false);
  assert.doesNotMatch(htmlDenied, /Confirm Offer Package/, 'Unscoped browser roles must not reveal the confirmation control');
  assert.doesNotMatch(render(true, false), /Confirm Offer Package/, 'Approval authority alone cannot bypass sensitive case permissions');
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