import { z } from "zod/v4";
import { createHash } from "node:crypto";

export const HISTORY_PAGE_SIZE = 30;

export interface HistoryScope {
  organizationId: string;
  userId: string;
  workflow?: string;
  status?: string;
  correlationId?: string;
}

const cursorSchema = z.object({
  v: z.literal(1),
  scope: z.string(),
  startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    .refine(value => Number.isFinite(Date.parse(value))),
  id: z.string().uuid(),
}).strict();

function scopeKey(scope: HistoryScope) {
  return createHash("sha256").update(JSON.stringify([scope.organizationId, scope.userId, scope.workflow ?? "",
    scope.status ?? "", scope.correlationId ?? ""])).digest("hex");
}

// A seek position is not authority. Every page still evaluates live access.
export function encodeHistoryCursor(scope: HistoryScope, startedAt: string, id: string) {
  return Buffer.from(JSON.stringify({ v: 1, scope: scopeKey(scope), startedAt, id })).toString("base64url");
}

export function decodeHistoryCursor(cursor: string, scope: HistoryScope) {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid history cursor");
  const parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  if (parsed.scope !== scopeKey(scope)) throw new Error("History cursor does not match this view");
  return parsed;
}
