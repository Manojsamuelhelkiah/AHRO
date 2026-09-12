export const AUDIT_ARCHIVE_FIELDS = [
  'providerId',
  'archiveNamespace',
  'retentionPolicyStatementOrReference',
  'independentAdministratorContact',
  'independentAdministratorRole',
  'credentialSecretReferenceName',
] as const;

export type AuditArchiveSignupConfig = Record<(typeof AUDIT_ARCHIVE_FIELDS)[number], string>;

export function parseAuditArchiveSignupFile(contents: string): AuditArchiveSignupConfig {
  if (contents.length > 64 * 1024) throw new Error('Audit archive configuration files must be 64 KB or smaller.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error('Audit archive configuration must be valid JSON.');
  }
  const candidate = typeof parsed === 'object' && parsed !== null && 'auditArchive' in parsed
    ? (parsed as { auditArchive: unknown }).auditArchive
    : parsed;
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new Error('Audit archive configuration must be a JSON object.');
  }
  const record = candidate as Record<string, unknown>;
  if (Object.keys(record).some((key) => !AUDIT_ARCHIVE_FIELDS.includes(key as typeof AUDIT_ARCHIVE_FIELDS[number]))) {
    throw new Error('Audit archive configuration contains unsupported fields. Secret values are not accepted.');
  }
  const config = Object.fromEntries(AUDIT_ARCHIVE_FIELDS.map((key) => [key, record[key]])) as AuditArchiveSignupConfig;
  if (AUDIT_ARCHIVE_FIELDS.some((key) => typeof config[key] !== 'string' || !config[key].trim())) {
    throw new Error('Audit archive configuration must include every required metadata field.');
  }
  return config;
}