import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextActions } from './overview';
import { caseOwnerOf, caseWorkerName } from '../case-presentation';

test('current owner is the relevant agent unless an actual unresolved assignment is projected', () => {
  const c = { hireType: 'offboarding' };
  assert.equal(caseOwnerOf(c).name, 'Offboarding Agent');
  assert.equal(caseOwnerOf({ ...c, currentActionOwner: 'Payroll Operations' }).name, 'Payroll Operations');
  assert.equal(caseOwnerOf({ ...c, currentActionOwner: 'Payroll Operations' }).coordinatingAgent, 'Offboarding Agent');
  assert.equal(caseOwnerOf({ ...c, currentActionOwner: 'Unassigned human team' }).kind, 'Human Reviewer');
  assert.equal(caseOwnerOf({ ...c, currentActionOwner: null }).name, 'Offboarding Agent');
  assert.equal(caseWorkerName({ id: 3237, offlineSample: true, fictionalOfflineIdentity: true,
    workerName: 'Demo sample — Voluntary offboarding' }), 'Voluntary offboarding');
});

test('offline next steps show distinct names, dependencies and actual state without automatic execution', () => {
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>
    <NextActions c={{ hireType: 'offboarding', offlineSample: true, workstreams: [
      { key: 'access', label: 'Access review', status: 'blocked', owner: 'IT / Security', blockers: ['Verified connector evidence required'] },
      { key: 'assets', label: 'Asset recovery', status: 'pending' },
      { key: 'restricted', label: 'Restricted confidential operational item', status: 'pending' },
      { key: 'restricted', label: 'Restricted confidential operational item', status: 'blocked' },
    ] }} pendingApprovals={[]} setTab={() => {}} />
  </QueryClientProvider>);
  assert.match(html, /Access review/);
  assert.match(html, /Verified connector evidence required/);
  assert.match(html, /Asset recovery/);
  assert.match(html, /Offboarding Agent/);
  assert.match(html, /no work is executing/);
  assert.doesNotMatch(html, /Begins automatically|Restricted confidential operational item/);
  assert.equal(html.match(/Operational wording is restricted/g)?.length, 1);
  assert.match(html, /Item 2: blocked/);
});
