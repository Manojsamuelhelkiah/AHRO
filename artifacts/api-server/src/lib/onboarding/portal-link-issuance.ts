import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCandidateLinks,
  onbCases,
  onbCommunications,
} from "@workspace/db/schema";
import { sendOutbound } from "./channels";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { ensureCaseLogistics } from "./case-logistics";
import { hashSecret, newSecret } from "./candidate-portal";
import { withCaseDispatchGuard } from "./dispatch-guard";

export const AUTOMATED_PORTAL_EMAIL_KEY = (caseId: number) =>
  `orchestration:${caseId}:portal:email`;

export function portalPublicBase(req: {
  protocol: string;
  get(name: string): string | undefined;
}) {
  const configured = process.env.ONBOARDING_PORTAL_PUBLIC_URL?.replace(/\/+$/, "");
  const requestHost = req.get("host") ?? "";
  if (configured) return configured;
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(requestHost)) {
    throw new Error("Unable to determine the portal URL");
  }
  return `${req.protocol}://${requestHost}`;
}

export async function issueCandidatePortalLink(input: {
  organizationId: string;
  caseId: number;
  issuedBy: string;
  publicBase: string;
  expiresInHours?: number;
  sendEmail: boolean;
  authorizeEmail?: boolean;
  idempotencyKey?: string;
}) {
  return withCaseDispatchGuard(
    input.caseId,
    () => issueCandidatePortalLinkUnsafe(input),
    { onOffline: () => issueCandidatePortalLinkUnsafe(input) },
  );
}

async function issueCandidatePortalLinkUnsafe(input: {
  organizationId: string;
  caseId: number;
  issuedBy: string;
  publicBase: string;
  expiresInHours?: number;
  sendEmail: boolean;
  authorizeEmail?: boolean;
  idempotencyKey?: string;
}) {
  const expiresInHours = input.expiresInHours ?? 168;
  if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) {
    throw new Error("Expiry must be between 1 and 720 hours");
  }

  const [c] = await db.select().from(onbCases).where(and(
    eq(onbCases.id, input.caseId),
    eq(onbCases.organizationId, input.organizationId),
  ));
  if (!c) return null;
  if (isSyntheticOfflineCase(c)) return null;
  if (
    (c.hireType === "external-fte" || c.hireType === "contractor" || c.hireType === "rehire") &&
    !c.offerAcceptanceComplete
  ) {
    throw new Error("Offer acceptance must be confirmed before issuing a candidate portal link");
  }

  if (input.idempotencyKey) {
    const [existingDelivery] = await db.select({
      id: onbCommunications.id,
      status: onbCommunications.status,
      failureReason: onbCommunications.failureReason,
    }).from(onbCommunications).where(and(
      eq(onbCommunications.organizationId, input.organizationId),
      eq(onbCommunications.idempotencyKey, input.idempotencyKey),
    ));
    if (existingDelivery) {
      const [activeLink] = await db.select({
        id: onbCandidateLinks.id,
        expiresAt: onbCandidateLinks.expiresAt,
      }).from(onbCandidateLinks).where(and(
        eq(onbCandidateLinks.organizationId, input.organizationId),
        eq(onbCandidateLinks.caseId, input.caseId),
        isNull(onbCandidateLinks.revokedAt),
      )).orderBy(desc(onbCandidateLinks.createdAt)).limit(1);
      return { ...activeLink, portalUrl: null, delivery: existingDelivery };
    }
  }

  const token = newSecret();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600_000);
  const [link] = await db.insert(onbCandidateLinks).values({
    organizationId: input.organizationId,
    caseId: input.caseId,
    tokenHash: hashSecret(token),
    expiresAt,
    issuedBy: input.issuedBy,
  }).returning();
  const portalUrl = `${input.publicBase}/candidate#token=${encodeURIComponent(token)}`;
  let delivery = null;

  if (input.sendEmail) {
    if (input.authorizeEmail) {
      await db.update(onbCases).set({
        candidateEmailAuthorizedAt: new Date(),
        candidateEmailAuthorizedBy: input.issuedBy,
        updatedAt: new Date(),
      }).where(and(
        eq(onbCases.id, input.caseId),
        eq(onbCases.organizationId, input.organizationId),
      ));
    }
    const logistics = await ensureCaseLogistics(input.organizationId, input.caseId, c.joiningDate);
    const logisticsLines = [
      logistics.orientationDate && `Date: ${logistics.orientationDate}`,
      logistics.orientationTime && `Time: ${logistics.orientationTime}${logistics.timezone ? ` (${logistics.timezone})` : ""}`,
      logistics.format && `Format: ${logistics.format}`,
      logistics.venueAddress && `Venue: ${logistics.venueAddress}`,
      logistics.googleMapsUrl && `Map: ${logistics.googleMapsUrl}`,
      logistics.meetingUrl && `Meeting: ${logistics.meetingUrl}`,
      logistics.reportingContact && `Reporting contact: ${logistics.reportingContact}`,
      logistics.arrivalInstructions && `Arrival instructions: ${logistics.arrivalInstructions}`,
    ].filter(Boolean).join("\n") || "Day-1 details will be shared in the portal when available.";
    delivery = await sendOutbound({
      caseId: input.caseId,
      channel: "email",
      toAddress: c.workerEmail,
      subject: `${c.workerName.split(" ")[0]}, your onboarding portal is ready`,
      body: `Hello ${c.workerName},\n\nUse your private onboarding portal to review Day-1 details and submit requested documents:\n${portalUrl}\n\n${logisticsLines}\n\nThis link expires ${expiresAt.toISOString()} and should not be forwarded.\n\nThe Onboarding Team`,
      persistedBody: `Hello ${c.workerName},\n\nA private onboarding portal link was issued and sent automatically. The secret link is not retained in the timeline.\n\n${logisticsLines}\n\nLink expiry: ${expiresAt.toISOString()}\n\nThe Onboarding Team`,
      sensitive: true,
      idempotencyKey: input.idempotencyKey,
    });
  }

  return { id: link.id, expiresAt, portalUrl, delivery };
}