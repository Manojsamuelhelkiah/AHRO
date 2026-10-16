import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emailIntakeErrorMessage } from './error-message';

test('409 preserves the real conversion blocker instead of inventing a stale version', () => {
  for (const message of [
    'Mailbox routing is paused, revoked or changed. A fresh route review is required.',
    'Save reviewed classification and fields before conversion.',
    'Acknowledge that private attachments remain quarantined and are not evidence.',
    'Potential independent duplicate requests need explicit review; no requests are automatically merged.',
    'Current sensitive lifecycle admission blocks conversion.',
    'Request changed. Reload before converting.',
  ]) assert.equal(emailIntakeErrorMessage({ status: 409, data: { message } }), message);
});
test('missing or malformed conflict responses do not claim a record changed or expose raw errors', () => {
  for (const message of [undefined, '', '<html>Server error</html>', 'x'.repeat(501)]) {
    const result = emailIntakeErrorMessage({ status: 409, data: { message } });
    assert.doesNotMatch(result, /record changed|<html>|xxxxx/i);
    assert.match(result, /blocked/);
  }
});
test('access failures retain safe session and permission explanations', () => {
  assert.match(emailIntakeErrorMessage({ status: 403, data: { message: 'private source content' } }), /permission/);
  assert.match(emailIntakeErrorMessage({ status: 401 }), /session/);
});
