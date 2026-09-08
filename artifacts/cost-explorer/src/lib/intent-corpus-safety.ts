import type { ActualsOverlayInput } from "@workspace/api-client-react";

export function isIntentCorpusUnavailable(
  isError: boolean,
  customIntentsAvailable: boolean | undefined,
): boolean {
  return isError || customIntentsAvailable !== true;
}

export function overlayRequiresCompleteCorpus(
  overlay: ActualsOverlayInput | null | undefined,
  referenceIntentKeys: ReadonlySet<string> = new Set(),
): boolean {
  return overlay?.intents?.some(({ intentKey }) => !referenceIntentKeys.has(intentKey)) ?? false;
}