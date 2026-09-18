import assert from 'node:assert/strict';
import test from 'node:test';
import { countMappedEstates, nonIntegratedSystemKeys } from './scenario-inputs';
import type { ClientSetupDraft } from './schema';

test('scenario assumptions count every mapped payroll and ticketing estate', () => {
  const systems: ClientSetupDraft['systems'] = [
    { id: 'payroll-us', key: 'payroll', name: 'US Payroll', vendor: 'A', mode: 'direct-integration', ownerEmail: '' },
    { id: 'payroll-de', key: 'payroll', name: 'DE Payroll', vendor: 'B', mode: 'direct-integration', ownerEmail: '' },
    { id: 'itsm-global', key: 'itsm', name: 'Global Tickets', vendor: 'C', mode: 'manual', ownerEmail: '' },
  ];

  assert.equal(countMappedEstates(systems), 3);
  assert.deepEqual(nonIntegratedSystemKeys(systems), ['ticketing']);
});