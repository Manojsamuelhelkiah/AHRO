import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  generateSlots,
  matchSlotChoice,
  nextBusinessDays,
  timezoneLabelFor,
  wantsCall,
} from "./scheduling";
import { documentPackFor } from "./documents";

describe("wantsCall", () => {
  test("detects kick-off call requests", () => {
    assert.equal(wantsCall("Can we have a kick off call sometime this week?"), true);
    assert.equal(wantsCall("I'd like to schedule a quick sync"), true);
    assert.equal(wantsCall("When can we book a meeting?"), true);
  });
  test("does not fire on unrelated messages", () => {
    assert.equal(wantsCall("I submitted my PAN card yesterday"), false);
    assert.equal(wantsCall("What laptop will I get?"), false);
  });
});

describe("nextBusinessDays / generateSlots", () => {
  test("skips weekends (in-zone)", () => {
    const friday = new Date("2026-08-14T09:00:00Z"); // Fri
    const days = nextBusinessDays(friday, 2, "Asia/Kolkata");
    const dow = (d: Date) =>
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(d);
    assert.equal(dow(days[0]!), "Mon");
    assert.equal(dow(days[1]!), "Tue");
  });
  test("produces three numbered future slots with labels", () => {
    const slots = generateSlots(new Date("2026-08-11T09:00:00Z"), "IST", "Asia/Kolkata");
    assert.equal(slots.length, 3);
    assert.deepEqual(slots.map((s) => s.n), [1, 2, 3]);
    for (const s of slots) {
      assert.ok(new Date(s.startIso).getTime() > new Date("2026-08-11T09:00:00Z").getTime());
      assert.ok(s.label.includes("IST"));
      assert.ok(s.label.includes("30 min"));
    }
  });
  test("slot instants are correct in the target zone (IST = UTC+5:30)", () => {
    const slots = generateSlots(new Date("2026-08-11T09:00:00Z"), "IST", "Asia/Kolkata");
    // slot 1 is 10:00 AM IST = 04:30 UTC
    const s1 = new Date(slots[0]!.startIso);
    assert.equal(s1.getUTCHours(), 4);
    assert.equal(s1.getUTCMinutes(), 30);
    assert.ok(slots[0]!.label.includes("10:00 AM IST"));
  });
  test("US Eastern respects DST (August = UTC-4)", () => {
    const slots = generateSlots(new Date("2026-08-11T09:00:00Z"), "ET", "America/New_York");
    const s1 = new Date(slots[0]!.startIso); // 10:00 AM ET = 14:00 UTC in August
    assert.equal(s1.getUTCHours(), 14);
  });
});

describe("matchSlotChoice", () => {
  const slots = generateSlots(new Date("2026-08-11T09:00:00Z"), "IST", "Asia/Kolkata");
  test("matches bare and phrased numbers", () => {
    assert.equal(matchSlotChoice(slots, "2")?.n, 2);
    assert.equal(matchSlotChoice(slots, "2 works for me")?.n, 2);
    assert.equal(matchSlotChoice(slots, "Option 3 works for me")?.n, 3);
    assert.equal(matchSlotChoice(slots, "slot 1 please")?.n, 1);
    assert.equal(matchSlotChoice(slots, "1.")?.n, 1);
  });
  test("matches a uniquely-named weekday", () => {
    const day3 = slots[2]!.label.split(",")[0]!; // second business day, unique
    assert.equal(matchSlotChoice(slots, `${day3} suits me best`)?.n, 3);
  });
  test("does NOT book on incidental numbers", () => {
    assert.equal(matchSlotChoice(slots, "I have 1 more question"), undefined);
    assert.equal(matchSlotChoice(slots, "Can we do it in 2 weeks instead?"), undefined);
    assert.equal(matchSlotChoice(slots, "My flight lands at 3"), undefined);
  });
  test("no match on ambiguous, off-menu or unrelated replies", () => {
    assert.equal(matchSlotChoice(slots, "none of these work"), undefined);
    assert.equal(matchSlotChoice(slots, "7 would be better"), undefined);
    assert.equal(matchSlotChoice(slots, "option 9"), undefined);
  });
});

describe("timezoneLabelFor", () => {
  test("maps geographies", () => {
    assert.equal(timezoneLabelFor("India"), "IST");
    assert.equal(timezoneLabelFor("United States"), "ET");
    assert.equal(timezoneLabelFor("Mars"), "UTC");
  });
});

describe("documentPackFor", () => {
  test("India employee gets PAN/UAN statutory docs", () => {
    const keys = documentPackFor({ workerCategory: "full-time", geography: "India", hireType: "external" }).map((d) => d.key);
    assert.ok(keys.includes("pan-card"));
    assert.ok(keys.includes("uan-epf"));
    assert.ok(keys.includes("signed-offer"));
  });
  test("contractor gets SOW instead of offer letter, no tax form requirement", () => {
    const pack = documentPackFor({ workerCategory: "contractor", geography: "US", hireType: "external" });
    const keys = pack.map((d) => d.key);
    assert.ok(keys.includes("signed-sow"));
    assert.ok(!keys.includes("signed-offer"));
    assert.equal(pack.find((d) => d.key === "tax-form")?.required, false);
  });
  test("unique keys per pack", () => {
    const keys = documentPackFor({ workerCategory: "full-time", geography: "UK", hireType: "rehire" }).map((d) => d.key);
    assert.equal(new Set(keys).size, keys.length);
  });
});
