import { Router, type IRouter, type RequestHandler } from "express";
import {
  ListIntentsResponse,
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
import { rowToIntent } from "./custom-intents";
import { db, customIntentsTable, type CustomIntentRow } from "@workspace/db";
import type { Intent } from "../data/types";
import { loadCurrentRateSet } from "../lib/pricing-rate-sets";
import { buildIntentRegistry } from "../lib/intent-registry";
import { getOrganizationId, organizationWhere } from "../lib/organization-scope";

const router: IRouter = Router();

/**
 * GET /intents — reference corpus merged with all active custom intents.
 * Each intent is augmented with an `isCustom` boolean so clients can badge them.
 */
export async function loadIntentCorpus(
  loadCustomRows: () => Promise<CustomIntentRow[]>,
) {
  const referenceWithFlag = intents.map((it) => ({ ...it, isCustom: false }));
  try {
    const customRows = await loadCustomRows();
    // All custom intents visible in the corpus list (active AND retired) so
    // detail pages resolve; roll-ups only include active ones.
    const customIntents = customRows.map(rowToIntent);

    const customWithFlag = customIntents.map((it) => ({
      ...it,
      isCustom: true,
      // Restore positive id for API response (rollup uses negative internally)
      id: Math.abs(it.id),
    }));
    return {
      intents: [...referenceWithFlag, ...customWithFlag],
      customIntentsAvailable: true,
    };
  } catch (customStorageError) {
    return {
      intents: referenceWithFlag,
      customIntentsAvailable: false,
      warning: "Built-in reference intents are available, but custom intents could not be loaded. Try again later.",
      customStorageError,
    };
  }
}

export function createListIntentsHandler(
  loadCorpus?: () => ReturnType<typeof loadIntentCorpus>,
): RequestHandler {
  return async (req, res) => {
    const corpus = await (loadCorpus
      ? loadCorpus()
      : loadIntentCorpus(() =>
          db
            .select()
            .from(customIntentsTable)
            .where(organizationWhere(customIntentsTable, getOrganizationId(req))),
        ));
    if (!corpus.customIntentsAvailable) {
      req.log?.warn(
        { err: corpus.customStorageError },
        "Custom-intent storage unavailable; serving bundled reference corpus",
      );
    }
    res.json(ListIntentsResponse.parse(corpus));
  };
}

router.get("/intents", createListIntentsHandler());

router.get("/flow-classes", (_req, res) => {
  res.json(ListFlowClassesResponse.parse(flowClasses));
});

router.get("/systems", (_req, res) => {
  res.json(ListSystemsResponse.parse(systems));
});

router.get("/profiles", (_req, res) => {
  res.json(ListDistributionProfilesResponse.parse(profiles));
});

router.get("/model-catalog", async (req, res, next) => {
  try {
    const currentRateSet = await loadCurrentRateSet(getOrganizationId(req));
    if (currentRateSet) {
      // Overlay snapshot rates onto the catalog entries so the GET reflects current prices.
      const overlaid = modelCatalog.map((m) => {
        const sr = currentRateSet.rates.modelRates?.[m.key];
        if (!sr) return m;
        return {
          ...m,
          pricePerCallUsd: sr.pricePerCallUsd,
          inputPricePerMillionTokens: sr.inputPricePerMillionTokens,
          outputPricePerMillionTokens: sr.outputPricePerMillionTokens,
        };
      });
      res.json(ListModelCatalogResponse.parse(overlaid));
    } else {
      res.json(ListModelCatalogResponse.parse(modelCatalog));
    }
  } catch (e) {
    next(e);
  }
});

router.get("/assumptions", (_req, res) => {
  res.json(ListAssumptionsResponse.parse(assumptions));
});

export async function loadCorpusSummary(
  loadCustomRows: () => Promise<CustomIntentRow[]>,
) {
  let activeCustom: Intent[] = [];
  let customIntentsAvailable = true;
  let customStorageError: unknown;

  try {
    const customRows = await loadCustomRows();
    activeCustom = customRows
      .filter((r) => r.status === "active" && r.registryVersion === buildIntentRegistry().version)
      .map(rowToIntent);
  } catch (error) {
    customIntentsAvailable = false;
    customStorageError = error;
  }

  const allIntents: Intent[] = [...intents, ...activeCustom];
  const count = (keyOf: (i: Intent) => string) => {
    const buckets = new Map<string, number>();
    for (const intent of allIntents) {
      const key = keyOf(intent);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([key, bucketCount]) => ({ key, count: bucketCount }));
  };

  return {
    intentCount: allIntents.length,
    systemCount: systems.length,
    profileCount: profiles.length,
    byDomain: count((intent) => intent.domain),
    byFlowClass: count((intent) => intent.flowClass),
    bySource: count((intent) => intent.source.name),
    customIntentsAvailable,
    ...(!customIntentsAvailable
      ? { warning: "Dashboard totals currently include built-in reference intents only because custom intents could not be loaded. Try again later." }
      : {}),
    customStorageError,
  };
}

export function createCorpusSummaryHandler(
  loadSummary?: () => ReturnType<typeof loadCorpusSummary>,
): RequestHandler {
  return async (req, res) => {
    const summary = await (loadSummary
      ? loadSummary()
      : loadCorpusSummary(() =>
          db
            .select()
            .from(customIntentsTable)
            .where(organizationWhere(customIntentsTable, getOrganizationId(req))),
        ));
    if (!summary.customIntentsAvailable) {
      req.log?.warn(
        { err: summary.customStorageError },
        "Custom-intent storage unavailable; serving reference-only corpus summary",
      );
    }
    res.json(GetCorpusSummaryResponse.parse(summary));
  };
}

router.get("/summary", createCorpusSummaryHandler());

router.get("/summary/routing", async (req, res, next) => {
  try {
    const customRows = await db
      .select()
      .from(customIntentsTable)
      .where(organizationWhere(customIntentsTable, getOrganizationId(req)));
    const registry = buildIntentRegistry(customRows);
    res.json({
      registryVersion: registry.version,
      ...registry.counts,
      costModelIntentCount: intents.length + registry.counts.activeCustom,
      reconciled:
        registry.counts.reference === intents.length
        && registry.counts.activeCustom === customRows.filter((row) =>
          row.status === "active" && row.registryVersion === registry.version).length,
    });
  } catch (e) {
    next(e);
  }
});

export default router;
