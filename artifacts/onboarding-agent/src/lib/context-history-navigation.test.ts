import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyContextHistoryDestination, correlationHistoryDestination } from './context-history-navigation';

test('legacy history links retain filters without redirecting ordinary settings or retention', () => {
  for (const hash of ['', '#context-metadata-retention', '#sensitive-lifecycle-policies']) {
    assert.equal(legacyContextHistoryDestination('?unrelated=value', hash), null);
  }
  assert.equal(legacyContextHistoryDestination('', '#unified-context-manager'), '/execution-history');
  const search = 'contextView=operator&contextCorrelation=opaque%2Fid&contextWorkflow=documents&contextStatus=failed';
  assert.equal(legacyContextHistoryDestination(search, ''), `/execution-history?${search}`);
  assert.equal(correlationHistoryDestination('personal', 'opaque/id'),
    '/execution-history?contextView=personal&contextCorrelation=opaque%2Fid');
});
