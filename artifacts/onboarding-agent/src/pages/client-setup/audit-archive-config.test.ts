import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAuditArchiveSignupFile } from './audit-archive-config';

const config = {
  providerId: 'approved-provider',
  archiveNamespace: 'client-archive',
  retentionPolicyStatementOrReference: 'Client policy POL-42',
  independentAdministratorContact: 'records@example.test',
  independentAdministratorRole: 'Independent records administrator',
  credentialSecretReferenceName: 'env:AUDIT_PROVIDER_TOKEN',
};

test('imports approved audit archive metadata from direct or wrapped JSON', () => {
  assert.deepEqual(parseAuditArchiveSignupFile(JSON.stringify(config)), config);
  assert.deepEqual(parseAuditArchiveSignupFile(JSON.stringify({ auditArchive: config })), config);
});

test('rejects incomplete, oversized, and secret-bearing configuration files', () => {
  assert.throws(() => parseAuditArchiveSignupFile('{'), /valid JSON/);
  assert.throws(() => parseAuditArchiveSignupFile(JSON.stringify({ ...config, token: 'secret' })), /unsupported fields/);
  assert.throws(() => parseAuditArchiveSignupFile(JSON.stringify({ ...config, providerId: '' })), /every required/);
  assert.throws(() => parseAuditArchiveSignupFile(' '.repeat(64 * 1024 + 1)), /64 KB/);
});