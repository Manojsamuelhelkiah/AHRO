import test from "node:test";
import assert from "node:assert/strict";
import { accountSessionLabel, compactAccountControls } from "./case-account-presentation";

test("case detail compacts irrelevant account instructions, not verification or errors", () => {
  assert.equal(compactAccountControls("/cases/3237", false, ""), true);
  assert.equal(compactAccountControls("/cases/3237", true, ""), false);
  assert.equal(compactAccountControls("/cases/3237", false, "Session could not be checked"), false);
  assert.equal(compactAccountControls("/cases", false, ""), false);
  assert.equal(compactAccountControls("/settings", false, ""), false);
  assert.match(accountSessionLabel("/cases/3237", false), /Administrator access not active/);
  assert.match(accountSessionLabel("/cases/3237", true), /Administrator access verified/);
});
