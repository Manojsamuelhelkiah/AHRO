/**
 * Bulk-load demo volunteers from demo/volunteers.json.
 *
 * Uses the exact same code path as the Settings -> Demo Volunteers screen:
 * saves the list (which authorizes live delivery to those contacts) and
 * creates a persona-shaped onboarding case per valid volunteer.
 *
 * Run with: pnpm run seed:volunteers   (from artifacts/api-server)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_ORGANIZATION_ID } from "@workspace/db/schema";
import {
  saveVolunteers,
  seedVolunteerCases,
  listPersonas,
  volunteerProblems,
  type DemoVolunteer,
} from "../lib/onboarding/demo-volunteers";

const isPlaceholder = (s: string | undefined) => !s || s.includes("FILL-") || /X{4,}/.test(s);

async function main() {
  const file = resolve(process.cwd(), "demo/volunteers.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { volunteers?: Partial<DemoVolunteer>[] };
  const rows = (parsed.volunteers ?? []).filter((v) => !isPlaceholder(v.name) && !isPlaceholder(v.email));
  if (rows.length === 0) {
    console.log("Nothing to load. Fill in demo/volunteers.json (replace FILL- placeholders) and run again.");
    process.exit(0);
  }

  const saved = await saveVolunteers(DEMO_ORGANIZATION_ID, rows);
  const personas = new Map(listPersonas().map((p) => [p.key, p]));
  for (const v of saved) {
    const problem = volunteerProblems(v);
    console.log(
      problem
        ? `! ${v.name}: ${problem} (not authorized for live delivery)`
        : `✓ ${v.name} <${v.email}>${v.phone ? ` ${v.phone}` : ""} — persona: ${personas.get(v.persona)?.title ?? v.persona} — live delivery authorized`,
    );
  }

  console.log("\nCreating demo cases...");
  const results = await seedVolunteerCases();
  for (const r of results) console.log(`  ${r.name}: ${r.status} — ${r.note}${r.caseId ? ` (case #${r.caseId})` : ""}`);

  console.log("\nWaiting 45s for the agent pipeline (plan, documents, first outreach) to settle...");
  await new Promise((res) => setTimeout(res, 45_000));
  console.log("Done. The list and per-persona briefings are visible in Settings -> Demo Volunteers.");
  console.log("(Twilio trial: phones must be Verified Caller IDs; WhatsApp volunteers must send the sandbox join message once.)");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
