import type { RateSetReference } from "@workspace/api-client-react";

export function formatRateSetReference(ref?: RateSetReference): string {
  if (!ref) return "";
  const dateStr = new Date(ref.effectiveDate).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Rate set v${ref.rateSetId} · effective ${dateStr}`;
}
