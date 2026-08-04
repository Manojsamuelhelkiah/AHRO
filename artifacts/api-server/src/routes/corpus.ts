import { Router, type IRouter } from "express";
import {
  ListIntentsResponse,
  ListFlowClassesResponse,
  ListSystemsResponse,
  ListDistributionProfilesResponse,
  ListAssumptionsResponse,
  GetCorpusSummaryResponse,
} from "@workspace/api-zod";
import { intents } from "../data/intents";
import { flowClasses } from "../data/flow-classes";
import { systems } from "../data/systems";
import { profiles } from "../data/profiles";
import { assumptions } from "../data/assumptions";

const router: IRouter = Router();

router.get("/intents", (_req, res) => {
  res.json(ListIntentsResponse.parse(intents));
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

router.get("/assumptions", (_req, res) => {
  res.json(ListAssumptionsResponse.parse(assumptions));
});

router.get("/summary", (_req, res) => {
  const count = (keyOf: (i: (typeof intents)[number]) => string) => {
    const m = new Map<string, number>();
    for (const it of intents) m.set(keyOf(it), (m.get(keyOf(it)) ?? 0) + 1);
    return [...m.entries()].map(([key, c]) => ({ key, count: c }));
  };
  res.json(
    GetCorpusSummaryResponse.parse({
      intentCount: intents.length,
      systemCount: systems.length,
      profileCount: profiles.length,
      byDomain: count((i) => i.domain),
      byFlowClass: count((i) => i.flowClass),
      bySource: count((i) => i.source.name),
    }),
  );
});

export default router;
