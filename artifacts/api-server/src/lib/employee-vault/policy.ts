import { createHash, createPublicKey, verify } from "node:crypto";
import type { VaultEvidenceBinding } from "@workspace/db";

export const VAULT_CHECK_KINDS = ["identity", "criminal", "employment", "education", "address", "sanctions", "reference", "medical"] as const;
export const VAULT_MAX_BYTES = 10 * 1024 * 1024;
export const VAULT_QUOTA_BYTES = 100 * 1024 * 1024;
export const VAULT_MAX_DOCUMENTS = 30;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Signed source claims have a fixed canonical wire representation. No status-only intake. */
export type VaultSourceResult = {
  submissionId: string; profileId: string; issuerId: string; kind: string; jurisdiction: string;
  bindings: VaultEvidenceBinding[]; outcome: "clear" | "adverse" | "inconclusive";
  sourceReference: string; verifiedAt: string; expiresAt: string;
};
export function sourcePayload(r: VaultSourceResult): string {
  return JSON.stringify([
    "employee-vault-source:v1", r.submissionId, r.profileId, r.issuerId, r.kind, r.jurisdiction,
    [...r.bindings].sort((a, b) => a.id.localeCompare(b.id)).map(b => [b.id, b.revision, b.sha256]),
    r.outcome, r.sourceReference, r.verifiedAt, r.expiresAt,
  ]);
}
export function authenticSource(r: VaultSourceResult, signature: string, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return key.asymmetricKeyType === "ed25519" &&
      /^[A-Za-z0-9+/]{86}==$/.test(signature) &&
      verify(null, Buffer.from(sourcePayload(r)), key, Buffer.from(signature, "base64"));
  } catch { return false; }
}
export function exactBindings(expected: VaultEvidenceBinding[], actual: VaultEvidenceBinding[]): boolean {
  return expected.length > 0 && expected.length === actual.length && new Set(actual.map(b => b.id)).size === actual.length &&
    expected.every(b => actual.some(a => a.id === b.id && a.revision === b.revision && a.sha256 === b.sha256));
}
export function safeDates(verifiedAt: Date, expiresAt: Date, now = new Date()): boolean {
  return Number.isFinite(verifiedAt.getTime()) && Number.isFinite(expiresAt.getTime()) &&
    verifiedAt <= now && expiresAt > now && expiresAt > verifiedAt;
}
export function allRequiredChecks(required: string[], reusable: string[]): boolean {
  // An empty/missing employer policy never becomes universal clearance.
  return required.some(k => k !== "identity") && required.every(k => reusable.includes(k));
}
