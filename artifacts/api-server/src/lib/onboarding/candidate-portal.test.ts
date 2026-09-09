import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CANDIDATE_FILE_BYTES,
  detectCandidateFile,
  hashSecret,
  newSecret,
  portalEmailRequested,
  validateLogistics,
} from "./candidate-portal";
import {
  logisticsForCase,
  parseDay1LogisticsDefault,
  SYNTHETIC_DAY1_LOGISTICS_DEFAULT,
  validateDay1LogisticsDefault,
} from "./logistics-defaults";

test("portal secrets are random and represented by SHA-256 hashes", () => {
  const first = newSecret();
  const second = newSecret();
  assert.notEqual(first, second);
  assert.match(hashSecret(first), /^[a-f0-9]{64}$/);
  assert.equal(hashSecret(first).includes(first), false);
});

test("logistics validates formats, timezones, and safe URLs", () => {
  const value = validateLogistics({
    orientationDate: "2026-04-01",
    orientationTime: "09:30",
    timezone: "Asia/Kolkata",
    format: "hybrid",
    googleMapsUrl: "https://maps.google.com/?q=office",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
  });
  assert.equal(value.format, "hybrid");
  assert.throws(() => validateLogistics({ format: "spaceship" }), /format/);
  assert.throws(() => validateLogistics({ timezone: "Not/AZone" }), /timezone/);
  assert.throws(() => validateLogistics({ googleMapsUrl: "https://evil.example/maps" }), /Google Maps/);
  assert.throws(() => validateLogistics({ meetingUrl: "javascript:alert(1)" }), /meeting/);
});

test("tenant logistics defaults reuse portal validation and resolve blank dates per case", () => {
  const parsed = parseDay1LogisticsDefault(JSON.stringify(SYNTHETIC_DAY1_LOGISTICS_DEFAULT));
  assert.equal(parsed.reportingContact, "Alex Example — Demo People Team");
  assert.equal(parsed.orientationDate, null);
  assert.equal(logisticsForCase(parsed, "2027-02-03").orientationDate, "2027-02-03");
  assert.equal(
    logisticsForCase({ ...parsed, orientationDate: "2027-02-01" }, "2027-02-03").orientationDate,
    "2027-02-01",
  );
  assert.throws(() => validateDay1LogisticsDefault([]), /JSON object/);
  assert.throws(() => validateDay1LogisticsDefault({ timezone: "Synthetic/Invalid" }), /timezone/);
  assert.throws(() => parseDay1LogisticsDefault("{"), /valid JSON/);
});

test("candidate file detection uses magic bytes rather than names", () => {
  assert.equal(detectCandidateFile(Buffer.from("%PDF-1.7\n")), "application/pdf");
  assert.equal(detectCandidateFile(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(detectCandidateFile(Buffer.from([137,80,78,71,13,10,26,10])), "image/png");
  assert.equal(detectCandidateFile(Buffer.from("fake.pdf")), undefined);
  assert.equal(MAX_CANDIDATE_FILE_BYTES, 10 * 1024 * 1024);
});

test("portal email is opt-in only for literal true", () => {
  assert.equal(portalEmailRequested(true), true);
  assert.equal(portalEmailRequested(false), false);
  assert.equal(portalEmailRequested(undefined), false);
  assert.equal(portalEmailRequested("true"), false);
});