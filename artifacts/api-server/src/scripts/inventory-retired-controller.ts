import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Read-only aggregate inventory: never print raw run/setup/recipient payloads.
const result = await db.execute(sql`
  SELECT
    (SELECT count(*) FROM onb_settings WHERE key LIKE 'demo-controller.run.v1:%') AS historical_runs,
    (SELECT count(*) FROM demo_controller_setup_requests) AS setup_requests,
    (SELECT count(*) FROM demo_controller_setup_requests WHERE completed_at IS NOT NULL) AS setup_grants,
    (SELECT count(*) FROM onb_settings WHERE key = 'demo_volunteers') AS volunteer_registries,
    (SELECT count(*) FROM onb_cases WHERE controller_retired) AS retired_cases,
    (SELECT count(*) FROM onb_communications m JOIN onb_cases c ON c.id=m.case_id AND c.organization_id=m.organization_id WHERE c.controller_retired) AS communications,
    (SELECT count(*) FROM onb_effect_journal j JOIN onb_cases c ON c.id=j.case_id AND c.organization_id=j.organization_id WHERE c.controller_retired) AS effects
`);
console.log(JSON.stringify(result.rows[0]));
process.exit(0);
