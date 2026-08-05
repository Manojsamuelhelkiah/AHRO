import { Router, type IRouter } from "express";
import {
  ListFlowClassesResponse,
  ListSystemsResponse,
  ListDistributionProfilesResponse,
  ListAssumptionsResponse,
  ListModelCatalogResponse,
  GetCorpusSummaryResponse,
} from "@workspace/api-zod";
import { intents } from "../data/intents";
import { flowClasses } from "../data/flow-classes";
import { systems } from "../data/systems";
import { profiles } from "../data/profiles";
import { assumptions } from "../data/assumptions";
import { modelCatalog } from "../data/model-catalog";
import { loadActiveCustomIntents, rowToIntent } from "./custom-intents";
import { db, customIntentsTable } from "@workspace/db";
import type { Intent } from "../data/types";

const router: IRouter = Router();

/**
 * GET /intents — reference corpus merged with all active custom intents.
 * Each intent is augmented with an `isCustom` boolean so clients can badge them.
 */
router.get("/intents", async (_req, res, next) => {
  try {
    const customRows = await db.select().from(customIntentsTable);
    // All custom intents visible in the corpus list (active AND retired) so
    // detail pages resolve; roll-ups only include active ones.
    const customIntents = customRows.map(rowToIntent);

    const referenceWithFlag = intents.map((it) => ({ ...it, isCustom: false }));
    const customWithFlag = customIntents.map((it) => ({
      ...it,
      isCustom: true,
      // Restore positive id for API response (rollup uses negative internally)
      id: Math.abs(it.id),
    }));
    res.json([...referenceWithFlag, ...customWithFlag]);
  } catch (e) {
    next(e);
  }
});

router.get("/flow-classes", (_req, res) => {
  res.json(ListFlowClassesResponse.parse(flowClasses));
});

router.get("/systems", (_req, res) => {
  res.json(ListSystemsResponse.parse(systems));
});

router.get("/profiles", (_req, res) => {
  res.json(ListDistributionProfilesResponse.parse(profiles));
});

router.get("/model-catalog", (_req, res) => {
  res.json(ListModelCatalogResponse.parse(modelCatalog));
});

router.get("/assumptions", (_req, res) => {
  res.json(ListAssumptionsResponse.parse(assumptions));
});

router.get("/summary", async (_req, res, next) => {
  try {
    const customRows = await db.select().from(customIntentsTable);
    const activeCustom = customRows
      .filter((r) => r.status === "active")
      .map(rowToIntent);
    const allIntents: Intent[] = [...intents, ...activeCustom];

    const count = (keyOf: (i: Intent) => string) => {
      const m = new Map<string, number>();
      for (const it of allIntents) m.set(keyOf(it), (m.get(keyOf(it)) ?? 0) + 1);
      return [...m.entries()].map(([key, c]) => ({ key, count: c }));
    };
    res.json(
      GetCorpusSummaryResponse.parse({
        intentCount: allIntents.length,
        systemCount: systems.length,
        profileCount: profiles.length,
        byDomain: count((i) => i.domain),
        byFlowClass: count((i) => i.flowClass),
        bySource: count((i) => i.source.name),
      }),
    );
  } catch (e) {
    next(e);
  }
});

export default router;
