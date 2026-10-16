// Explicit one-time operation only. Never wire into startup or post-merge setup.
import { parseArgs } from "node:util";
import { pool } from "@workspace/db";
import { assertDemoJobProfileDevelopment, provisionDemoJobProfiles } from "../lib/onboarding/demo-job-profiles";

try {
  assertDemoJobProfileDevelopment();
  const { values } = parseArgs({ options: {
    "preview-host": { type: "string" },
    "confirm-demo": { type: "boolean" },
  } });
  const host = process.env.REPLIT_DEV_DOMAIN;
  if (!host?.endsWith(".replit.dev") || values["preview-host"] !== host || !values["confirm-demo"]) {
    throw new Error("Verify the intended development Preview and pass --preview-host matching REPLIT_DEV_DOMAIN plus --confirm-demo.");
  }
  console.log(JSON.stringify(await provisionDemoJobProfiles()));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Demo job-profile provisioning failed.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
