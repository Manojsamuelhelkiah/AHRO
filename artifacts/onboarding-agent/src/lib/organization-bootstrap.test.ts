import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveOrganizationBootstrap,
  resolveOrganizationSwitch,
} from './organization-bootstrap';

test('organization bootstrap sends users without memberships to setup', () => {
  assert.deepEqual(
    resolveOrganizationBootstrap(
      { needsSetup: true, activeOrganizationId: null, memberships: [] },
      null,
    ),
    { kind: 'setup' },
  );
});

test('organization bootstrap replaces a stale stored selector', () => {
  assert.deepEqual(
    resolveOrganizationBootstrap(
      {
        needsSetup: false,
        activeOrganizationId: null,
        memberships: [{ organizationId: 'org_second' }],
      },
      'org_stale',
    ),
    { kind: 'ready', organizationId: 'org_second', selectorChanged: true },
  );
});

test('organization switch accepts a freshly validated current membership', () => {
  assert.deepEqual(
    resolveOrganizationSwitch(
      {
        needsSetup: false,
        activeOrganizationId: 'org_target',
        memberships: [
          { organizationId: 'org_old' },
          { organizationId: 'org_target' },
        ],
      },
      'org_target',
    ),
    { kind: 'ready', organizationId: 'org_target' },
  );
});

test('organization switch rejects a stale target that is not in current memberships', () => {
  assert.deepEqual(
    resolveOrganizationSwitch(
      {
        needsSetup: false,
        activeOrganizationId: 'org_old',
        memberships: [{ organizationId: 'org_old' }],
      },
      'org_stale',
    ),
    {
      kind: 'rejected',
      organizationId: 'org_stale',
      reason: 'not-member',
    },
  );
});

test('organization switch rejects a revoked target even when the account has no memberships', () => {
  assert.deepEqual(
    resolveOrganizationSwitch(
      { needsSetup: true, activeOrganizationId: null, memberships: [] },
      'org_revoked',
    ),
    {
      kind: 'rejected',
      organizationId: 'org_revoked',
      reason: 'no-membership',
    },
  );
});

test('a failed switch leaves the already committed tenant unchanged', () => {
  const currentOrganizationId = 'org_old';
  const decision = resolveOrganizationSwitch(
    {
      needsSetup: false,
      activeOrganizationId: null,
      memberships: [{ organizationId: 'org_old' }],
    },
    'org_revoked',
  );

  assert.equal(decision.kind, 'rejected');
  assert.equal(currentOrganizationId, 'org_old');
});

test('bootstrap recovers safely when the stored tenant was revoked', () => {
  assert.deepEqual(
    resolveOrganizationBootstrap(
      {
        needsSetup: false,
        activeOrganizationId: null,
        memberships: [{ organizationId: 'org_remaining' }],
      },
      'org_revoked',
    ),
    {
      kind: 'ready',
      organizationId: 'org_remaining',
      selectorChanged: true,
    },
  );
});