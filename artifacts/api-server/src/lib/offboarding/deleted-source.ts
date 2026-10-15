import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { onbSettings } from "@workspace/db";
import { SeparationError } from "./model";

// A receipt for the expressly authorized, one-time development cleanup.
// No public deletion API or automatic cleanup is exposed.
export const HRO_CLEANUP_RECEIPT_KEY = "maintenance.demo-hro-cleanup.2026-10-15.v1";

export function deletedSourceDigest(organizationId: string, channel: string, reference: string) {
  return createHash("sha256").update(JSON.stringify([organizationId, channel, reference])).digest("hex");
}

export function receiptBlocksSource(value: string, digest: string): boolean {
  const receipt = JSON.parse(value);
  if (receipt?.version !== 1 || receipt?.organizationId !== "demo" ||
      !Array.isArray(receipt.offboardingSourceTombstones) ||
      receipt.offboardingSourceTombstones.some((s: unknown) => typeof s !== "string" || !/^[a-f0-9]{64}$/.test(s))) {
    throw new Error("Invalid cleanup source tombstones");
  }
  return receipt.offboardingSourceTombstones.includes(digest);
}

export async function assertNotDeletedSourceInTransaction(
  tx: any, organizationId: string, channel: string, reference: string,
) {
  if (organizationId !== "demo") return;
  const [receipt] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, HRO_CLEANUP_RECEIPT_KEY),
  ));
  if (!receipt) return;
  let blocked: boolean;
  try {
    blocked = receiptBlocksSource(receipt.value, deletedSourceDigest(organizationId, channel, reference));
  } catch {
    throw new SeparationError("Deleted-source verification is unavailable. No new case was created.", 503);
  }
  if (blocked) throw new SeparationError("This source belongs to a permanently deleted case and cannot recreate it.", 409);
}
