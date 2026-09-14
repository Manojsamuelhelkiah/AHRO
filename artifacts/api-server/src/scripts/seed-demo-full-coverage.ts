import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import {
  DEMO_FULL_COVERAGE_SCENARIO_KEYS,
  seedDemoFullCoverage,
} from "../lib/onboarding/demo-full-coverage";

async function main() {
  const result = await seedDemoFullCoverage(DEMO_ORGANIZATION_ID, "development-demo-seed");
  console.log(`Demo full coverage: ${result.createdCaseIds.length} created, ${result.existingCaseIds.length} already present.`);
  console.log(`Families: ${DEMO_FULL_COVERAGE_SCENARIO_KEYS.join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});