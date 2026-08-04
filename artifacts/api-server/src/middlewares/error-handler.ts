import type { NextFunction, Request, Response } from "express";
import { InputValidationError } from "../lib/validate-inputs";
import { logger } from "../lib/logger";

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
