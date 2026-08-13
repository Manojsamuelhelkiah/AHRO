/**
 * Seed demo onboarding cases from demo/volunteers.json.
 *
 * Reads the fill-in template, skips placeholder rows and volunteers who
 * already have an active case, creates a case per volunteer through the
 * same intake used by the app (full agent pipeline: plan, document pack,
 * workstreams, events), waits for orchestration to settle, then prints
 * the ONBOARDING_ALLOWED_RECIPIENTS value needed for live sends/calls.
 *
 * Run with: pnpm run seed:volunteers   (from artifacts/api-server)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "@workspace/db";
import { onbCases } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  defaultReadiness,
  defaultWorkstreams,
  startOrchestration,
} from "../lib/onboarding/engine";

type Volunteer = {
  name: string;
  email: string;
  phone?: string;
  channelPreference?: string;
  role?: string;
  department?: string;
  geography?: string;
  hireType?: string;
  workerCategory?: string;
  managerName?: string;
  recruiterName?: string;
  joiningDate?: string;
  notes?: string;
};

const isPlaceholder = (s: string | undefined) =>
  !s || s.includes("FILL-") || /X{4,}/.test(s);

async function main() {
  const file = resolve(process.cwd(), "demo/volunteers.json");
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { volunteers?: Volunteer[] };
  const volunteers = parsed.volunteers ?? [];

  const seeded: Volunteer[] = [];
  const skipped: string[] = [];

  for (const v of volunteers) {
    if (isPlaceholder(v.name) || isPlaceholder(v.email)) {
      skipped.push(`${v.name ?? "(unnamed)"} — still a placeholder, not filled in`);
      continue;
    }
    if (!/^\S+@\S+\.\S+$/.test(v.email)) {
      skipped.push(`${v.name} — invalid email "${v.email}"`);
      continue;
    }
    const phone = (v.phone ?? "").trim();
    if (phone && !/^\+\d{8,15}$/.test(phone.replace(/[\s-]/g, ""))) {
      skipped.push(`${v.name} — phone "${phone}" must be international format like +919876543210`);
      continue;
    }
    const [dupe] = await db
      .select({ id: onbCases.id })
      .from(onbCases)
      .where(
        and(
          sql`lower(${onbCases.workerName}) = ${v.name.toLowerCase()}`,
          sql`${onbCases.lifecycleStage} not in ('complete')`,
        ),
      );
    if (dupe) {
      skipped.push(`${v.name} — already has an active case (#${dupe.id})`);
      continue;
    }

    const pref = ["email", "whatsapp", "both"].includes(v.channelPreference ?? "")
      ? (v.channelPreference as string)
      : phone
        ? "both"
        : "email";

    const [row] = await db
      .insert(onbCases)
      .values({
        workerName: v.name,
        workerEmail: v.email,
        workerPhone: phone || null,
        channelPreference: pref,
        hireType: v.hireType ?? "external",
        workerCategory: v.workerCategory ?? "full-time",
        role: v.role ?? "Software Engineer",
        department: v.department ?? "Engineering",
        geography: v.geography ?? "India",
        legalEntity: "Demo Legal Entity",
        managerName: isPlaceholder(v.managerName) ? "Demo Manager" : v.managerName!,
        recruiterName: isPlaceholder(v.recruiterName) ? "Demo Recruiter" : v.recruiterName!,
        joiningDate: v.joiningDate ?? new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10),
        primarySkill: null,
        skillCriticality: null,
        notes: v.notes ?? "Demo volunteer",
        scenarioKey: null,
        readiness: defaultReadiness(),
        workstreams: defaultWorkstreams(),
        orchestrationStatus: "running",
      })
      .returning();
    startOrchestration(row.id);
    seeded.push(v);
    console.log(`✓ seeded case #${row.id}: ${v.name} <${v.email}>${phone ? ` ${phone}` : ""} (${pref})`);
  }

  for (const s of skipped) console.log(`- skipped: ${s}`);

  if (seeded.length > 0) {
    console.log("\nWaiting 45s for the agent pipeline (plan, documents, first outreach) to settle...");
    await new Promise((r) => setTimeout(r, 45_000));
    const rows = await db
      .select({ id: onbCases.id, name: onbCases.workerName, status: onbCases.orchestrationStatus, stage: onbCases.lifecycleStage })
      .from(onbCases)
      .where(eq(onbCases.notes, "Demo volunteer"));
    for (const r of rows) console.log(`  case #${r.id} ${r.name}: ${r.stage} / ${r.status}`);

    const addresses = [
      ...seeded.map((v) => v.email.toLowerCase()),
      ...seeded.map((v) => (v.phone ?? "").trim()).filter(Boolean),
    ];
    console.log("\nTo enable REAL emails, WhatsApp and voice calls to these volunteers, set:");
    console.log(`ONBOARDING_ALLOWED_RECIPIENTS=${addresses.join(",")}`);
    console.log("(Twilio trial: each phone must also be a Verified Caller ID in the Twilio console.)");
  } else {
    console.log("\nNothing seeded. Fill in demo/volunteers.json (replace the FILL- placeholders) and run again.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
