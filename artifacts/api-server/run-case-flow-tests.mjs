import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Each exact path is in run-tests.mjs's ownedWorkspaceSuites set. That runner
// migrates a disposable schema with no shared search_path fallback and verifies
// the original organization inventory after dropping it.
const suites = [
  "src/lib/flow-manager/contract.test.ts",
  "src/lib/onboarding/channel-flow-action.test.ts",
  "src/lib/flow-manager/manager.test.ts",
  "src/lib/onboarding/gateway-guards.test.ts",
  "src/lib/onboarding/engine-document-gate.test.ts",
  "src/lib/onboarding/approval-versioning.test.ts",
  "src/lib/onboarding/effect-journal.test.ts",
  "src/lib/onboarding/workstream-connectors.test.ts",
  "src/lib/onboarding/operational-requests.test.ts",
  "src/lib/offboarding/offboarding.test.ts",
  "src/lib/offboarding/exchange-runtime.test.ts",
  "src/lib/privacy-enforcement.test.ts",
];
const cwd = path.dirname(fileURLToPath(import.meta.url));
for (const suite of suites) {
  console.log(`\nCase-flow regression: ${suite}`);
  const result = spawnSync(process.execPath, ["run-tests.mjs"], {
    cwd, stdio: "inherit", env: { ...process.env, NODE_ENV: "test", TEST_FILE: suite, REQUIRE_ISOLATED_TEST_SCHEMA: "true" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
