import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CaseHeader } from './components';
import { CaseAccessProvider, type CaseAccessPermissions } from './case-access';

const sample = {
  id: 3644, workerName: 'Example — Kiran Pine', role: 'Support Engineer',
  geography: 'Singapore', joiningDate: '2030-11-24', hireType: 'internal-transfer',
  caseFamily: 'Employee Changes', requestType: 'Role change near payroll cutoff',
  urgency: 'standard', lifecycleStage: 'service-intake', orchestrationStatus: 'blocked',
  offlineSample: true, fictionalOfflineIdentity: true, controllerRetired: true,
};
const permissions: CaseAccessPermissions = {
  caseId: 3644, access: { flowRead: true, profileRead: true, notesRead: true, flowEdit: false, profileEdit: false, notesEdit: false },
  sensitive: { identity: { read: false, edit: false }, medical: { read: false, edit: false }, payroll: { read: false, edit: false }, bgv: { read: false, edit: false } },
};
function header(c = sample, access = permissions) {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}>
    <CaseAccessProvider value={access}><CaseHeader c={c} caseId={c.id} /></CaseAccessProvider>
  </QueryClientProvider>);
  client.clear();
  return html;
}
test('sample header has exact reference, clean subtitle and concise offline warning with no live controls', () => {
  const html = header();
  assert.ok(html.includes('S3644'));
  assert.ok(html.includes('Kiran Pine • Support Engineer • Singapore'));
  assert.ok(html.includes(' • Effective Nov 24, 2030'));
  assert.ok(html.includes('Offline — read-only; no outreach or business completion.'));
  assert.ok(!/Case #3644|For Example|Example — Kiran|Example · Offline/.test(html));
  assert.ok(!/Take Action|>Contact<|Voice:/.test(html));
});
test('profile denial keeps sample worker and role details hidden', () => {
  const html = header(sample, { ...permissions, access: { ...permissions.access, profileRead: false } });
  assert.ok(html.includes('Restricted candidate'));
  assert.ok(html.includes('Profile details restricted'));
  assert.ok(!/Kiran Pine|Support Engineer|Worker Details/.test(html));
});
test('historical records preserve numeric identifiers, identity permission checks and existing warning', () => {
  const historical = { ...sample, fictionalOfflineIdentity: false };
  const restricted = header(historical);
  assert.ok(restricted.includes('Case #3644'));
  assert.ok(restricted.includes('Restricted candidate'));
  assert.ok(!restricted.includes('Kiran Pine'));
  const visible = header(historical, { ...permissions, sensitive: { ...permissions.sensitive, identity: { read: true, edit: false } } });
  assert.ok(visible.includes('For Example — Kiran Pine'));
  assert.ok(visible.includes('Historical test record — read-only; no provider work or business completion is authorized.'));
  assert.ok(!visible.includes('S3644'));
});
