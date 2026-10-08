export class HroContextBudgetError extends Error {
  constructor(readonly code: "HRO_AI_INPUT_TOO_LARGE" | "HRO_AI_INVALID_BUDGET") {
    super(code);
    this.name = "HroContextBudgetError";
  }
}
export const HRO_AI_CONTEXT_LIMITS = Object.freeze({
  maxInputTokenUpperBound: 24_000,
  maxOutputTokens: 16_000,
  maxCombinedTokenUpperBound: 40_000,
});

/**
 * UTF-8 bytes conservatively bound text token count. We deliberately do NOT
 * truncate mandatory policy/evidence or generate an unreviewed summary.
 * The authorized domain builder chooses relevant content before this check.
 */
export function checkHroAiBudget(
  messages: readonly { content?: unknown }[],
  outputTokens: number,
) {
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 ||
      outputTokens > HRO_AI_CONTEXT_LIMITS.maxOutputTokens || !messages.length) {
    throw new HroContextBudgetError("HRO_AI_INVALID_BUDGET");
  }
  let inputBytes = 0;
  for (const message of messages) {
    if (typeof message.content !== "string") {
      throw new HroContextBudgetError("HRO_AI_INVALID_BUDGET");
    }
    inputBytes += Buffer.byteLength(message.content, "utf8") + 32;
  }
  if (inputBytes > HRO_AI_CONTEXT_LIMITS.maxInputTokenUpperBound ||
      inputBytes + outputTokens > HRO_AI_CONTEXT_LIMITS.maxCombinedTokenUpperBound) {
    throw new HroContextBudgetError("HRO_AI_INPUT_TOO_LARGE");
  }
  return Object.freeze({ inputBytes, outputTokens });
}
