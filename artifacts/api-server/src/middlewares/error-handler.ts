import type { NextFunction, Request, Response } from "express";
import { RetiredCaseCapabilityError } from "../lib/retired-case-capabilities";
import { InputValidationError } from "../lib/validate-inputs";
import { logger } from "../lib/logger";
import { FlowTransitionError } from "../lib/flow-manager/errors";

export const CUSTOM_INTENT_STORAGE_UNAVAILABLE_CODE = "CUSTOM_INTENT_STORAGE_UNAVAILABLE";
export const CUSTOM_INTENT_STORAGE_UNAVAILABLE_MESSAGE =
  "Custom intent data is temporarily unavailable. Retry the request later.";

export class CustomIntentStorageUnavailableError extends Error {
  readonly code = CUSTOM_INTENT_STORAGE_UNAVAILABLE_CODE;

  constructor(options?: ErrorOptions) {
    super(CUSTOM_INTENT_STORAGE_UNAVAILABLE_MESSAGE, options);
    this.name = "CustomIntentStorageUnavailableError";
  }
}

interface ZodLikeIssue {
  path?: Array<string | number>;
  message?: string;
}

function isZodError(err: unknown): err is { issues: ZodLikeIssue[] } {
  return (
    err instanceof Error &&
    err.name === "ZodError" &&
    Array.isArray((err as unknown as { issues?: unknown }).issues)
  );
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof FlowTransitionError) {
    res.status(409).json({ code: err.code, message: err.message });
    return;
  }
  if (err instanceof RetiredCaseCapabilityError) {
    res.status(410).json({ code: err.code, message: err.message });
    return;
  }
  if (err instanceof CustomIntentStorageUnavailableError) {
    logger.warn({ err }, "Custom-intent storage unavailable for dependent request");
    res.status(503).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof InputValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (isZodError(err)) {
    const first = err.issues[0];
    res.status(400).json({
      error: `Invalid request: ${
        first ? `${(first.path ?? []).join(".")} ${first.message ?? ""}`.trim() : "validation failed"
      }`,
    });
    return;
  }
  logger.error({ err: err as Error }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
}
