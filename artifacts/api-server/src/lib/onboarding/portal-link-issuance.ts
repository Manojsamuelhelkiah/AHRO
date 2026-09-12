import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCandidateLinks,
  onbCases,
  onbCommunications,
} from "@workspace/db/schema";
import { sendOutbound } from "./channels";
import { isSyntheticOfflineCase } from "./synthetic-offline";
import { initializeCaseLogistics } from "./case-logistics";
import { hashSecret, newSecret } from "./candidate-portal";
import { withCaseDispatchGuard } from "./dispatch-guard";
import {
  dispatchWithProviderGovernance,
  evaluateProviderGovernanceGate,
  PROVIDER_GOVERNANCE_WORKFLOW,
} from "./governance-provider-boundary";
import { withCaseDerivedLifecycleWrite, withSensitiveLifecycleFence } from "./sensitive-lifecycle";
import { withSensitiveAuthorityFence } from "./sensitive-access";

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
  // A returned URL is a bearer credential to the candidate’s identity,
  // logistics, and document-upload surface. Do not infer this authority from
  // an owner role, demo identity, or a prior case snapshot.
  return withSensitiveLifecycleFence(input.organizationId, () => withSensitiveAuthorityFence({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorUserId: input.issuedBy,
    classification: "identity",
    additionalClassifications: ["medical", "payroll", "bgv"],
    mutate: () => withCaseDispatchGuard(
      input.caseId,
      () => issueCandidatePortalLinkUnsafe(input),
      { onOffline: () => issueCandidatePortalLinkUnsafe(input) },
    ),
  }));
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
  // Issuing a bearer link is privacy-sensitive processing even when HR chose
  // not to email it. Evaluate inside the case dispatch fence before creating
  // the token; old policy snapshots never serve as a permission fallback.
  const governance = await evaluateProviderGovernanceGate(
    c,
    PROVIDER_GOVERNANCE_WORKFLOW.portal,
  );
  if (!governance.allowed) {
    throw new Error(governance.reason!);
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

  // Link issuance is an explicit, full-authority action. It is the safe
  // legacy backfill point for a case that predates persisted Day-1 logistics;
  // reads intentionally do not create this opaque record.
  const logistics = await initializeCaseLogistics(input.organizationId, input.caseId);
  const token = newSecret();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600_000);
  const linkDispatch = await dispatchWithProviderGovernance({
    caseRow: c,
    workflow: PROVIDER_GOVERNANCE_WORKFLOW.portal,
    operation: `candidate-portal-link:${input.caseId}:${input.idempotencyKey ?? "manual"}`,
    providerId: "internal-candidate-portal",
    // Re-evaluate under the organization dispatch fence immediately before
    // persisting a new bearer credential. The separate email path is guarded
    // again by channels.ts before Gmail I/O.
    dispatch: async () => {
      const [link] = await db.insert(onbCandidateLinks).values({
        organizationId: input.organizationId,
        caseId: input.caseId,
        tokenHash: hashSecret(token),
        expiresAt,
        issuedBy: input.issuedBy,
      }).returning();
      if (!link) throw new Error("Candidate portal link was not persisted.");
      return link;
    },
    disposition: () => "sent",
  });
  if (!linkDispatch.dispatched) throw new Error(linkDispatch.reason);
  const link = linkDispatch.value;
  const portalUrl = `${input.publicBase}/candidate#token=${encodeURIComponent(token)}`;
  let delivery = null;

  if (input.sendEmail) {
    if (input.authorizeEmail) {
      await withCaseDerivedLifecycleWrite({
        organizationId: input.organizationId,
        caseId: input.caseId,
      }, (tx) =>
        tx.update(onbCases).set({
          candidateEmailAuthorizedAt: new Date(),
          candidateEmailAuthorizedBy: input.issuedBy,
          updatedAt: new Date(),
        }).where(and(
          eq(onbCases.id, input.caseId),
          eq(onbCases.organizationId, input.organizationId),
        )),
      );
    }
    const logisticsLines = [
      logistics?.orientationDate && `Date: ${logistics.orientationDate}`,
      logistics?.orientationTime && `Time: ${logistics.orientationTime}${logistics.timezone ? ` (${logistics.timezone})` : ""}`,
      logistics?.format && `Format: ${logistics.format}`,
      logistics?.venueAddress && `Venue: ${logistics.venueAddress}`,
      logistics?.googleMapsUrl && `Map: ${logistics.googleMapsUrl}`,
      logistics?.meetingUrl && `Meeting: ${logistics.meetingUrl}`,
      logistics?.reportingContact && `Reporting contact: ${logistics.reportingContact}`,
      logistics?.arrivalInstructions && `Arrival instructions: ${logistics.arrivalInstructions}`,
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