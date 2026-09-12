import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { canonicalJson } from "../lib/onboarding/standard-intake";

const SOURCE_HEADER = "x-ta-intake-source";
const TIMESTAMP_HEADER = "x-ta-intake-timestamp";
const SIGNATURE_HEADER = "x-ta-intake-signature";
const MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 30_000;

type SourceConfig = {
  organizationId: string;
  sourceId: string;
  secret: string;
  label?: string;
};

declare global {
  namespace Express {
    interface Request {
      trustedTaIntakeSource?: {
        sourceId: string;
        sourceIdentity: string;
      };
    }
  }
}

function configuredSources(raw = process.env.TA_INTAKE_SOURCES_JSON): SourceConfig[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SourceConfig =>
      item && typeof item === "object" &&
      typeof item.organizationId === "string" && item.organizationId.trim().length > 0 &&
      typeof item.sourceId === "string" && item.sourceId.trim().length > 0 &&
      typeof item.secret === "string" && item.secret.length >= 32,
    );
  } catch {
    return [];
  }
}

export function taIntakeSignature(opts: {
  secret: string;
  method: string;
  path: string;
  sourceId: string;
  timestamp: string;
  body: unknown;
}): string {
  return createHmac("sha256", opts.secret)
    .update(["ta-onboarding-intake:v1", opts.method.toUpperCase(), opts.path, opts.sourceId, opts.timestamp, canonicalJson(opts.body)].join("\n"))
    .digest("hex");
}

/**
 * Service-to-service TA intake authentication. The source configuration maps
 * a source identity to one tenant; a caller-provided organization header can
 * only narrow that fixed mapping, never select another tenant.
 */
export function requireTrustedTaIntake(req: Request, res: Response, next: NextFunction): void {
  const sourceId = req.header(SOURCE_HEADER)?.trim();
  const timestamp = req.header(TIMESTAMP_HEADER)?.trim();
  const signature = req.header(SIGNATURE_HEADER)?.trim();
  if (!sourceId || !timestamp || !signature) {
    res.status(401).json({ message: "TA intake authentication headers are required." });
    return;
  }
  const sources = configuredSources().filter((candidate) => candidate.sourceId === sourceId);
  if (sources.length !== 1) {
    res.status(403).json({ message: "TA intake source is not configured." });
    return;
  }
  const source = sources[0]!;
  const at = Number(timestamp);
  const age = Date.now() - at;
  if (!Number.isSafeInteger(at) || age > MAX_AGE_MS || age < -MAX_FUTURE_SKEW_MS) {
    res.status(401).json({ message: "TA intake signature timestamp is expired or invalid." });
    return;
  }
  const requestedOrganization = req.header("x-organization-id")?.trim();
  if (requestedOrganization && requestedOrganization !== source.organizationId) {
    res.status(403).json({ message: "TA intake source is not authorized for the requested organization." });
    return;
  }
  const expected = taIntakeSignature({
    secret: source.secret, method: req.method,
    path: new URL(req.originalUrl || req.url, "http://internal").pathname,
    sourceId, timestamp, body: req.body,
  });
  if (!/^[a-f0-9]{64}$/i.test(signature)) {
    res.status(401).json({ message: "TA intake signature is invalid." });
    return;
  }
  const received = Buffer.from(signature, "hex");
  const calculated = Buffer.from(expected, "hex");
  if (received.length !== calculated.length || !timingSafeEqual(received, calculated)) {
    res.status(401).json({ message: "TA intake signature is invalid." });
    return;
  }
  req.organizationId = source.organizationId;
  req.organizationRole = "member";
  req.authUserId = `ta-middleware:${source.sourceId}`;
  req.trustedTaIntakeSource = {
    sourceId: source.sourceId,
    sourceIdentity: source.label?.trim() || `TA middleware source ${source.sourceId}`,
  };
  next();
}