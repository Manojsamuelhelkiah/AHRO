import { GetOnboardingActionCenterQueryParams } from "@workspace/api-zod";
import { z } from "zod";

// Coerce only literal query booleans. Boolean("false") must never select true,
// and arbitrary strings are not an explicit job-context choice.
const booleanQuery = z.union([z.boolean(), z.enum(["true", "false"]).transform(v => v === "true")]).optional();
const query = GetOnboardingActionCenterQueryParams.extend({
  safetyCritical: booleanQuery,
  siteExposure: booleanQuery,
  limit: GetOnboardingActionCenterQueryParams.shape.limit.refine(Number.isSafeInteger),
});
export const parseActionCenterQuery = (input: unknown) => query.safeParse(input);
