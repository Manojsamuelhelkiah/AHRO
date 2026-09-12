import assert from "node:assert/strict";
import test from "node:test";
import { parseExternalAuditArchiveConfig } from "./settings";

const valid = {
  providerId: "client-approved-archive",
  archiveNamespace: "tenant-audit",
  retentionPolicyStatementOrReference: "Client legal reviewed policy ref POL-42",
  independentAdministratorContact: "archive-admin@example.test",
  independentAdministratorRole: "Independent records administrator",
  credentialSecretReferenceName: "vault:audit/client-approved-archive",
};

test("audit archive signup metadata is strict and contains no secret values", () => {
  assert.deepEqual(parseExternalAuditArchiveConfig(valid), valid);
  assert.throws(
    () => parseExternalAuditArchiveConfig({ ...valid, credentialSecret: "do-not-store" }),
    /Unsupported audit archive field/,
  );
  assert.throws(
    () => parseExternalAuditArchiveConfig({ ...valid, credentialSecretReferenceName: "token=value" }),
    /env:UPPER_SNAKE_NAME or vault:path/,
  );
  assert.throws(
    () => parseExternalAuditArchiveConfig({ ...valid, credentialSecretReferenceName: "sk-live-1234567890" }),
    /env:UPPER_SNAKE_NAME or vault:path/,
  );
  assert.equal(
    parseExternalAuditArchiveConfig({ ...valid, credentialSecretReferenceName: "env:AUDIT_PROVIDER_TOKEN" })?.credentialSecretReferenceName,
    "env:AUDIT_PROVIDER_TOKEN",
  );
  assert.throws(
    () => parseExternalAuditArchiveConfig({ ...valid, providerId: "" }),
    /providerId is required/,
  );
  assert.equal(parseExternalAuditArchiveConfig(undefined), null);
});