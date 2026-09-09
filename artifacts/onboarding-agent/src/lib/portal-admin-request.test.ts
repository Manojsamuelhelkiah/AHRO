import assert from 'node:assert/strict';
import test from 'node:test';
import { pinOrganizationIdForPage } from '@workspace/api-client-react';
import { portalAdminRequest } from './portal-admin-request';

test('portal administration sends the selected organization for multi-workspace users', async (t) => {
  const originalFetch = globalThis.fetch;
  let selectedOrganization: string | null = null;
  globalThis.fetch = async (_input, init) => {
    selectedOrganization = new Headers(init?.headers).get('x-organization-id');
    return new Response(JSON.stringify({ activeLink: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    pinOrganizationIdForPage(null);
  });

  pinOrganizationIdForPage('workspace-selected-from-two-memberships');
  const response = await portalAdminRequest<{ activeLink: null }>(
    '/api/onboarding/cases/42/portal',
  );

  assert.equal(selectedOrganization, 'workspace-selected-from-two-memberships');
  assert.equal(response.activeLink, null);
});