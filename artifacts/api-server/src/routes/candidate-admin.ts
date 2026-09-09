import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { onbCandidateLinks, onbCaseLogistics, onbCases } from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import { newSecret, hashSecret, portalEmailRequested, validateLogistics } from "../lib/onboarding/candidate-portal";
import { sendOutbound } from "../lib/onboarding/channels";

const router: IRouter = Router();

function logisticsText(logistics: typeof onbCaseLogistics.$inferSelect | undefined) {
  if (!logistics) return "Day-1 details will be shared in the portal when available.";
  return [
    logistics.orientationDate && `Date: ${logistics.orientationDate}`,
    logistics.orientationTime && `Time: ${logistics.orientationTime}${logistics.timezone ? ` (${logistics.timezone})` : ""}`,
    logistics.format && `Format: ${logistics.format}`,
    logistics.venueAddress && `Venue: ${logistics.venueAddress}`,
    logistics.googleMapsUrl && `Map: ${logistics.googleMapsUrl}`,
    logistics.meetingUrl && `Meeting: ${logistics.meetingUrl}`,
    logistics.reportingContact && `Reporting contact: ${logistics.reportingContact}`,
    logistics.arrivalInstructions && `Arrival instructions: ${logistics.arrivalInstructions}`,
  ].filter(Boolean).join("\n") || "Day-1 details will be shared in the portal when available.";
}

router.get("/onboarding/cases/:id/portal", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const organizationId = getOrganizationId(req);
    const [[c], [logistics], [link]] = await Promise.all([
      db.select({ id: onbCases.id }).from(onbCases).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId))),
      db.select().from(onbCaseLogistics).where(and(eq(onbCaseLogistics.caseId, caseId), eq(onbCaseLogistics.organizationId, organizationId))),
      db.select({ id: onbCandidateLinks.id, expiresAt: onbCandidateLinks.expiresAt, revokedAt: onbCandidateLinks.revokedAt, createdAt: onbCandidateLinks.createdAt })
        .from(onbCandidateLinks).where(and(eq(onbCandidateLinks.caseId, caseId), eq(onbCandidateLinks.organizationId, organizationId), isNull(onbCandidateLinks.revokedAt)))
        .orderBy(desc(onbCandidateLinks.createdAt)).limit(1),
    ]);
    if (!c) { res.status(404).json({ message: "Case not found" }); return; }
    res.json({ logistics: logistics ?? null, activeLink: link ?? null });
  } catch (error) { next(error); return; }
});

router.put("/onboarding/cases/:id/logistics", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const organizationId = getOrganizationId(req);
    const [c] = await db.select({ id: onbCases.id }).from(onbCases).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)));
    if (!c) { res.status(404).json({ message: "Case not found" }); return; }
    let values;
    try { values = validateLogistics(req.body ?? {}); } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "Invalid logistics" }); return;
    }
    const [row] = await db.insert(onbCaseLogistics).values({ organizationId, caseId, ...values })
      .onConflictDoUpdate({ target: [onbCaseLogistics.organizationId, onbCaseLogistics.caseId], set: { ...values, updatedAt: new Date() } }).returning();
    res.json(row);
  } catch (error) { next(error); return; }
});

router.post("/onboarding/cases/:id/portal-links", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const organizationId = getOrganizationId(req);
    const [c] = await db.select().from(onbCases).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)));
    if (!c) { res.status(404).json({ message: "Case not found" }); return; }
    const expiresInHours = Number(req.body?.expiresInHours ?? 168);
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) { res.status(400).json({ message: "Expiry must be between 1 and 720 hours" }); return; }
    const configuredBase = process.env.ONBOARDING_PORTAL_PUBLIC_URL?.replace(/\/+$/, "");
    const requestHost = req.get("host") ?? "";
    if (!configuredBase && !/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(requestHost)) {
      res.status(400).json({ message: "Unable to determine the portal URL" }); return;
    }
    const publicBase = configuredBase || `${req.protocol}://${requestHost}`;
    const token = newSecret(); const expiresAt = new Date(Date.now() + expiresInHours * 3600_000);
    const [link] = await db.insert(onbCandidateLinks).values({
      organizationId, caseId, tokenHash: hashSecret(token), expiresAt, issuedBy: req.authUserId!,
    }).returning();
    const portalUrl = `${publicBase}/candidate#token=${encodeURIComponent(token)}`;
    let delivery = null;
    if (portalEmailRequested(req.body?.sendEmail)) {
      // Checking "send" is the explicit, authenticated authorization action.
      // Merely creating/copying a link never changes candidate email consent.
      await db.update(onbCases).set({
        candidateEmailAuthorizedAt: new Date(),
        candidateEmailAuthorizedBy: req.authUserId!,
        updatedAt: new Date(),
      }).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)));
      const [logistics] = await db.select().from(onbCaseLogistics).where(and(eq(onbCaseLogistics.caseId, caseId), eq(onbCaseLogistics.organizationId, organizationId)));
      const emailBody = `Hello ${c.workerName},\n\nUse your private onboarding portal to review Day-1 details and submit requested documents:\n${portalUrl}\n\n${logisticsText(logistics)}\n\nThis link expires ${expiresAt.toISOString()} and should not be forwarded.\n\nThe Onboarding Team`;
      delivery = await sendOutbound({
        caseId, channel: "email", toAddress: c.workerEmail,
        subject: `${c.workerName.split(" ")[0]}, your onboarding portal is ready`,
        body: emailBody,
        persistedBody: `Hello ${c.workerName},\n\nA private onboarding portal link was explicitly issued and sent. The secret link is not retained in the timeline.\n\n${logisticsText(logistics)}\n\nLink expiry: ${expiresAt.toISOString()}\n\nThe Onboarding Team`,
        sensitive: true,
      });
    }
    res.status(201).json({ id: link.id, portalUrl, expiresAt: expiresAt.toISOString(), delivery });
  } catch (error) { next(error); return; }
});

router.delete("/onboarding/cases/:id/portal-links/:linkId", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const linkId = Number(req.params.linkId); const organizationId = getOrganizationId(req);
    const [row] = await db.update(onbCandidateLinks).set({ revokedAt: new Date() }).where(and(
      eq(onbCandidateLinks.id, linkId), eq(onbCandidateLinks.caseId, caseId), eq(onbCandidateLinks.organizationId, organizationId),
    )).returning({ id: onbCandidateLinks.id });
    if (!row) { res.status(404).json({ message: "Portal link not found" }); return; }
    res.status(204).send();
  } catch (error) { next(error); return; }
});

export default router;