import { db } from "@workspace/db";
import { onbCallSlots, onbCases } from "@workspace/db/schema";
import { and, desc, eq } from "drizzle-orm";

/**
 * Kick-off call scheduling. No external calendar is connected, so the
 * agent owns a simple slot book: it proposes concrete numbered slots in
 * the email and the hire books one just by replying with the number
 * (or the day). Bookings are confirmed on the audit trail.
 */

export type Slot = { n: number; startIso: string; label: string };
type SlotRow = typeof onbCallSlots.$inferSelect;

const TZ_BY_GEO: Array<[RegExp, string, string]> = [
  [/india/i, "IST", "Asia/Kolkata"],
  [/\b(us|usa|united states|america)\b/i, "ET", "America/New_York"],
  [/\b(uk|united kingdom|britain)\b/i, "UK time", "Europe/London"],
  [/europe|germany|france|netherlands|poland/i, "CET", "Europe/Berlin"],
  [/singapore|apac/i, "SGT", "Asia/Singapore"],
];

export function timezoneLabelFor(geography: string): string {
  for (const [re, tz] of TZ_BY_GEO) if (re.test(geography)) return tz;
  return "UTC";
}

export function ianaZoneFor(geography: string): string {
  for (const [re, , zone] of TZ_BY_GEO) if (re.test(geography)) return zone;
  return "UTC";
}

/** Wall-clock parts of a UTC instant as seen in an IANA zone. */
function zonedParts(d: Date, zone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", hour12: false, weekday: "short",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")) % 24, minute: Number(get("minute")), weekday: get("weekday"),
  };
}

/**
 * The UTC instant at which the given IANA zone shows `hour:minute` on the
 * same zone-local calendar day as `dayInZone`. DST-safe (offset is derived
 * from the zone itself, iteratively corrected).
 */
export function zonedTime(dayInZone: Date, zone: string, hour: number, minute: number): Date {
  const p = zonedParts(dayInZone, zone);
  // First guess: treat the target wall-clock as if it were UTC, then
  // correct by the observed difference. Two rounds handle DST edges.
  let guess = new Date(Date.UTC(p.year, p.month - 1, p.day, hour, minute));
  for (let i = 0; i < 2; i++) {
    const seen = zonedParts(guess, zone);
    const deltaMin =
      (seen.day - p.day) * 1440 + (seen.hour - hour) * 60 + (seen.minute - minute);
    if (deltaMin === 0) break;
    guess = new Date(guess.getTime() - deltaMin * 60_000);
  }
  return guess;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Next N business days *as seen in the given zone*, returned as UTC
 * instants at zone-local noon (a stable representative of the day).
 */
export function nextBusinessDays(from: Date, count: number, zone = "UTC"): Date[] {
  const days: Date[] = [];
  let cursor = new Date(from);
  while (days.length < count) {
    cursor = new Date(cursor.getTime() + 24 * 3600_000);
    const noon = zonedTime(cursor, zone, 12, 0);
    const wd = zonedParts(noon, zone).weekday;
    if (wd !== "Sat" && wd !== "Sun") days.push(noon);
  }
  return days;
}

/** Three concrete zone-correct slots over the next two business days. */
export function generateSlots(now: Date, tzLabel: string, zone = "UTC"): Slot[] {
  const [d1, d2] = nextBusinessDays(now, 2, zone) as [Date, Date];
  const mk = (day: Date, hour: number, minute: number, n: number): Slot => {
    const start = zonedTime(day, zone, hour, minute);
    const p = zonedParts(start, zone);
    const hh = p.hour > 12 ? p.hour - 12 : p.hour === 0 ? 12 : p.hour;
    const ampm = p.hour >= 12 ? "PM" : "AM";
    const mm = p.minute < 10 ? `0${p.minute}` : String(p.minute);
    const dow = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(start);
    return {
      n,
      startIso: start.toISOString(),
      label: `${dow}, ${MONTHS[p.month - 1]} ${p.day} at ${hh}:${mm} ${ampm} ${tzLabel} (30 min)`,
    };
  };
  return [mk(d1, 10, 0, 1), mk(d1, 15, 30, 2), mk(d2, 11, 0, 3)];
}

export function formatSlotOffer(slots: Slot[]): string {
  return [
    "Here are open kick-off call slots — reply with just the number to book:",
    ...slots.map((s) => `  ${s.n}. ${s.label}`),
  ].join("\n");
}

/** Store a proposal, superseding any earlier un-booked one (atomic). */
export async function proposeSlots(caseId: number, slots: Slot[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(onbCallSlots)
      .set({ status: "superseded" })
      .where(and(eq(onbCallSlots.caseId, caseId), eq(onbCallSlots.status, "proposed")));
    await tx.insert(onbCallSlots).values({ caseId, slots, status: "proposed" });
  });
}

export async function pendingProposal(caseId: number): Promise<SlotRow | undefined> {
  const [row] = await db
    .select()
    .from(onbCallSlots)
    .where(and(eq(onbCallSlots.caseId, caseId), eq(onbCallSlots.status, "proposed")))
    .orderBy(desc(onbCallSlots.id))
    .limit(1);
  return row;
}

/** Does the hire's message ask for a call/meeting? */
export function wantsCall(text: string): boolean {
  return /\b(kick[\s-]?off|call|meeting|meet|catch[\s-]?up|sync|chat|discussion)\b/i.test(text) &&
    /\b(schedule|book|set ?up|arrange|have|can we|could we|would like|want|when|time|slot|calendar|invite)\b/i.test(text);
}

/**
 * Match a booking reply against a pending proposal. Deliberately strict
 * to avoid false positives ("I have 1 more question" must NOT book):
 * only a bare-number reply ("2", "2 please", "2 works for me"), an
 * explicit selector phrase ("option 2", "slot 2", "number 2"), or a
 * uniquely-matching weekday name counts as a booking.
 */
export function matchSlotChoice(slots: Slot[], text: string): Slot | undefined {
  const t = text.trim();
  // explicit selector anywhere: "option 2", "slot 2", "number 2", "no. 2"
  const explicit = t.match(/\b(?:option|slot|number|no\.?)\s*#?\s*([1-9])\b/i);
  // bare number at the very start, followed only by pleasantries
  const bare = t.match(/^#?([1-9])\b[\s.!,)]*(?:please|works(?: for me| great(?: for me)?)?|is (?:fine|good|great|perfect)|sounds (?:good|great)|thanks.*|pls)?[\s.!,]*$/i);
  const numStr = explicit?.[1] ?? bare?.[1];
  if (numStr) {
    const byN = slots.find((s) => s.n === Number(numStr));
    if (byN) return byN;
    return undefined; // they named a number that isn't on offer — don't guess
  }
  const lower = t.toLowerCase();
  const byDay = slots.filter((s) => lower.includes((s.label.split(",")[0] ?? "").toLowerCase()));
  if (byDay.length === 1) return byDay[0];
  return undefined;
}

/** Book a slot: mark the proposal booked. Returns false if already booked. */
export async function bookSlot(proposalId: number, slot: Slot): Promise<boolean> {
  const rows = await db
    .update(onbCallSlots)
    .set({ status: "booked", bookedSlotN: slot.n, bookedAt: new Date() })
    .where(and(eq(onbCallSlots.id, proposalId), eq(onbCallSlots.status, "proposed")))
    .returning({ id: onbCallSlots.id });
  return rows.length > 0;
}

/** Latest booked slot for a case (for LLM context / UI). */
export async function bookedCall(caseId: number): Promise<{ slot: Slot; bookedAt: Date } | null> {
  const [row] = await db
    .select()
    .from(onbCallSlots)
    .where(and(eq(onbCallSlots.caseId, caseId), eq(onbCallSlots.status, "booked")))
    .orderBy(desc(onbCallSlots.id))
    .limit(1);
  if (!row || row.bookedSlotN == null) return null;
  const slot = row.slots.find((s) => s.n === row.bookedSlotN);
  return slot ? { slot, bookedAt: row.bookedAt ?? row.createdAt } : null;
}
