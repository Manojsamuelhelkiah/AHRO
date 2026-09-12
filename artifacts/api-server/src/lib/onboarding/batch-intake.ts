import { createHash } from "node:crypto";
import { offerAcceptanceRequired } from "./engine";

/** Stable, order-insensitive request fingerprint used to fence retry keys. */
export function batchIntakePayloadFingerprint(name: string, people: readonly Record<string, unknown>[]): string {
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
    return value;
  };
  const payload = {
    name: name.trim(),
    people: [...people]
      .map(canonicalize)
      .sort((left, right) => String((left as Record<string, unknown>).personKey).localeCompare(String((right as Record<string, unknown>).personKey))),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** A release cannot become an alternate path around the dedicated Gate A flow. */
export function eligibleForExplicitBatchRelease(hireType: string): boolean {
  return !offerAcceptanceRequired({ hireType });
}