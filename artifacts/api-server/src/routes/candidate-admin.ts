import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@workspace/db";
import { onbCandidateLinks, onbCaseLogistics, onbCases } from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import { portalEmailRequested, validateLogistics } from "../lib/onboarding/candidate-portal";
import { ensureCaseLogistics } from "../lib/onboarding/case-logistics";
import { issueCandidatePortalLink, portalPublicBase } from "../lib/onboarding/portal-link-issuance";
import {
  SensitiveLifecycleConflictError,
  withCaseDerivedLifecycleWrite,
  withSensitiveLifecycleFence,
} from "../lib/onboarding/sensitive-lifecycle";
import {
  SensitiveAuthorityRequiredError,
  withSensitiveAuthorityFence,
} from "../lib/onboarding/sensitive-access";

const router: IRouter = Router();

function withFullOpaqueCaseAuthority<T>(input: {
  organizationId: string;
  caseId: number;
  actorUserId: string;
  mutate: () => Promise<T>;
}): Promise<T> {
  // Lifecycle is the outer fence. The nested authority transaction holds the
  // live case-scoped grants/revocations through the entire sensitive action.
  return withSensitiveLifecycleFence(input.organizationId, () => withSensitiveAuthorityFence({
    organizationId: input.organizationId,
    caseId: input.caseId,
    actorUserId: input.actorUserId,
    classification: "identity",
    additionalClassifications: ["medical", "payroll", "bgv"],
    mutate: input.mutate,
  }));
}

router.get("/onboarding/cases/:id/portal", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const organizationId = getOrganizationId(req);
    const [c] = await db.select({ id: onbCases.id })
      .from(onbCases).where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)));
    if (!c) { res.status(404).json({ message: "Case not found" }); return; }
    const { logistics, link } = await withFullOpaqueCaseAuthority({
      organizationId, caseId, actorUserId: req.authUserId!,
      mutate: async () => {
        const [logistics, [link]] = await Promise.all([
          ensureCaseLogistics(organizationId, caseId),
          db.select({ id: onbCandidateLinks.id, expiresAt: onbCandidateLinks.expiresAt, revokedAt: onbCandidateLinks.revokedAt, createdAt: onbCandidateLinks.createdAt })
            .from(onbCandidateLinks).where(and(eq(onbCandidateLinks.caseId, caseId), eq(onbCandidateLinks.organizationId, organizationId), isNull(onbCandidateLinks.revokedAt)))
            .orderBy(desc(onbCandidateLinks.createdAt)).limit(1),
        ]);
        return { logistics, link };
      },
    });
    res.json({ logistics: logistics ?? null, activeLink: link ?? null });
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current case-scoped sensitive authority is required to access candidate logistics." });
      return;
    }
    next(error); return;
  }
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
    const rows = await withFullOpaqueCaseAuthority({
      organizationId, caseId, actorUserId: req.authUserId!,
      mutate: () => withCaseDerivedLifecycleWrite<Array<typeof onbCaseLogistics.$inferSelect>>(
        { organizationId, caseId },
        (tx) => tx.insert(onbCaseLogistics).values({ organizationId, caseId, ...values })
          .onConflictDoUpdate({ target: [onbCaseLogistics.organizationId, onbCaseLogistics.caseId], set: { ...values, updatedAt: new Date() } }).returning(),
      ),
    });
    const [row] = rows;
    res.json(row);
  } catch (error) {
    if (error instanceof SensitiveLifecycleConflictError) {
      res.status(409).json({ message: error.message.replace(/^SENSITIVE_LIFECYCLE_BLOCKED:/, "") });
      return;
    }
    if (error instanceof SensitiveAuthorityRequiredError) {
      res.status(403).json({ message: "Current case-scoped sensitive authority is required to change candidate logistics." });
      return;
    }
    next(error); return;
  }
});

router.post("/onboarding/cases/:id/portal-links", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const organizationId = getOrganizationId(req);
    const expiresInHours = Number(req.body?.expiresInHours ?? 168);
    if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 720) { res.status(400).json({ message: "Expiry must be between 1 and 720 hours" }); return; }
    let result;
    try {
      result = await issueCandidatePortalLink({
        organizationId,
        caseId,
        issuedBy: req.authUserId!,
        publicBase: portalPublicBase(req),
        expiresInHours,
        sendEmail: portalEmailRequested(req.body?.sendEmail),
        authorizeEmail: portalEmailRequested(req.body?.sendEmail),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Unable to determine the portal URL") {
        res.status(400).json({ message: error.message }); return;
      }
      if (error instanceof SensitiveAuthorityRequiredError) {
        res.status(403).json({ message: "Current case-scoped sensitive authority is required to issue a candidate portal link." }); return;
      }
      throw error;
    }
    if (!result) { res.status(404).json({ message: "Case not found" }); return; }
    res.status(201).json({
      id: result.id,
      portalUrl: result.portalUrl,
      expiresAt: result.expiresAt.toISOString(),
      delivery: result.delivery,
    });
  } catch (error) { next(error); return; }
});

router.delete("/onboarding/cases/:id/portal-links/:linkId", async (req, res, next) => {
  try {
    const caseId = Number(req.params.id); const linkId = Number(req.params.linkId); const organizationId = getOrganizationId(req);
    // Credential removal is deliberately not lifecycle-gated: a missing
    // collection policy must never prevent a tenant from revoking access.
    const [row] = await withSensitiveLifecycleFence(organizationId, () =>
      db.update(onbCandidateLinks).set({ revokedAt: new Date() }).where(and(
        eq(onbCandidateLinks.id, linkId), eq(onbCandidateLinks.caseId, caseId), eq(onbCandidateLinks.organizationId, organizationId),
      )).returning({ id: onbCandidateLinks.id }),
    );
    if (!row) { res.status(404).json({ message: "Portal link not found" }); return; }
    res.status(204).send();
  } catch (error) { next(error); return; }
});

export default router;