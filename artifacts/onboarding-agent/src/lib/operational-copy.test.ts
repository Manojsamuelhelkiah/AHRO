import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adapterDescriptionText, adapterVendorText, deliveryStatusText, operationalReferenceText } from './operational-copy';
import { confirmedCaseDate } from '../pages/cases/case-presentation';

test('delivery labels never promote a prepared, blocked or uncertain record to sent', () => {
  for (const status of ['simulated', 'logged-only', 'blocked', 'uncertain']) {
    assert.doesNotMatch(deliveryStatusText(status), /^(sent|delivered)$/i);
    assert.doesNotMatch(deliveryStatusText(status), /simulat|synthetic|fictional/i);
  }
  assert.equal(deliveryStatusText('sent'), 'sent');
  assert.equal(deliveryStatusText('delivered'), 'delivered');
  assert.equal(deliveryStatusText('failed'), 'failed');
  assert.equal(operationalReferenceText('SIMULATED-OPS-123-access'), 'OPS-123-access');
  assert.equal(operationalReferenceText('AP-123-V1'), 'AP-123-V1');
});

test('adapter and date display preserves persisted source values and genuine live dates', () => {
  assert.equal(adapterVendorText('Workday (simulated)'), 'Workday');
  assert.equal(adapterVendorText('Actual vendor'), 'Actual vendor');
  assert.equal(adapterDescriptionText('No webhook, or simulated completion is configured.'), 'No webhook is configured.');
  const c = { joiningDate: '2030-11-24', fictionalOfflineIdentity: true, offlineSample: true };
  assert.equal(confirmedCaseDate(c), null);
  assert.equal(confirmedCaseDate({ ...c, fictionalOfflineIdentity: false }), '2030-11-24');
  assert.equal(confirmedCaseDate({ ...c, operationalActivated: true }), '2030-11-24');
  assert.equal(c.joiningDate, '2030-11-24');
});
