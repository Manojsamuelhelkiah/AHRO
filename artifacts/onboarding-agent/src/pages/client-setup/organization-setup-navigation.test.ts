import assert from 'node:assert/strict';
import test from 'node:test';
import {
  organizationActionFromSearch,
  organizationSetupNavigation,
  organizationSetupNavigationNeedsReload,
} from './organization-setup-navigation';

test('organization setup action follows the reactive query string', () => {
  assert.equal(organizationActionFromSearch('?organizationAction=create'), 'create');
  assert.equal(organizationActionFromSearch('organizationAction=join'), 'join');
  assert.equal(organizationActionFromSearch('?organizationAction=other'), null);
});

test('full setup navigation removes only the setup action and preserves recovery params', () => {
  assert.equal(
    organizationSetupNavigation(
      '/client-setup',
      '?organizationAction=create&scenarioId=42',
      '#join-code',
    ),
    '/client-setup?scenarioId=42#join-code',
  );
});

test('canonical setup navigation requires an explicit reload', () => {
  assert.equal(
    organizationSetupNavigationNeedsReload('/client-setup', '/client-setup'),
    true,
  );
  assert.equal(
    organizationSetupNavigationNeedsReload(
      '/client-setup?organizationAction=join',
      '/client-setup',
    ),
    false,
  );
});