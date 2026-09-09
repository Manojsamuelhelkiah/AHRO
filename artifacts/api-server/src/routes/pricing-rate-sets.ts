import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, pricingRateSetsTable } from "@workspace/db";
import {
  ListPricingRateSetsResponse,
  CreatePricingRateSetBody,
  CreatePricingRateSetResponse,
} from "@workspace/api-zod";
import {
  requireAuth,
  requirePricingRateManager,
  resolveReviewerName,
  userCanManagePricingRates,
} from "../middlewares/require-auth";
import {
  validateRateSetBody,
  validateRateSnapshot,
  ensureBaselineRateSet,
  loadCurrentRateSet,
  type PricingRateSnapshot,
} from "../lib/pricing-rate-sets";
import { getOrganizationId } from "../lib/organization-scope";

const router: IRouter = Router();

function serializeRow(row: typeof pricingRateSetsTable.$inferSelect) {
  return {
    id: row.id,
    effectiveDate: row.effectiveDate,
    rationale: row.rationale,
    rates: row.rates as Record<string, unknown>,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /pricing-rate-sets
 * Returns the current effective rate set and all versions.
 * Ensures the baseline is seeded if no versions exist.
 */
router.get("/pricing-rate-sets", requireAuth, async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    await ensureBaselineRateSet(organizationId);

    const [current, allVersions, canManage] = await Promise.all([
      loadCurrentRateSet(organizationId),
      db
        .select()
        .from(pricingRateSetsTable)
        .where(eq(pricingRateSetsTable.organizationId, organizationId))
        .orderBy(desc(pricingRateSetsTable.id)),
      userCanManagePricingRates(req.authUserId!),
    ]);

    const response = {
      current: current
        ? {
            id: current.id,
            effectiveDate: current.effectiveDate,
            rationale: current.rationale,
            rates: current.rates as unknown as Record<string, unknown>,
            createdBy: current.createdBy,
            createdAt: current.createdAt.toISOString(),
          }
        : null,
      versions: allVersions.map(serializeRow),
      canManage,
    };

    res.json(ListPricingRateSetsResponse.parse(response));
  } catch (err) {
    next(err);
  }
});

/**
 * POST /pricing-rate-sets
 * Creates a new immutable rate set version.
 * Validates completeness and safety of all quote-critical rates.
 * Future effectiveDate is allowed (scheduled version).
 */
router.post(
  "/pricing-rate-sets",
  requireAuth,
  requirePricingRateManager,
  async (req, res, next) => {
  try {
    const body = CreatePricingRateSetBody.parse(req.body);

    // Full validation: effectiveDate, rationale, and all rate keys.
    const validation = validateRateSetBody(body);
    if (!validation.valid) {
      res.status(400).json({ error: validation.errors.join("; ") });
      return;
    }

    // Validate the snapshot completeness independently for explicit error reporting.
    const snapshotValidation = validateRateSnapshot(body.rates);
    if (!snapshotValidation.valid) {
      res.status(400).json({ error: snapshotValidation.errors.join("; ") });
      return;
    }

    const userId = req.authUserId!;
    const organizationId = getOrganizationId(req);
    const createdBy = await resolveReviewerName(userId);

    const [row] = await db
      .insert(pricingRateSetsTable)
      .values({
        effectiveDate: body.effectiveDate as string,
        rationale: body.rationale as string,
        rates: body.rates as Record<string, unknown>,
        createdBy,
        organizationId,
      })
      .returning();

    res.status(201).json(CreatePricingRateSetResponse.parse(serializeRow(row!)));
  } catch (err) {
    next(err);
  }
  },
);

export default router;
