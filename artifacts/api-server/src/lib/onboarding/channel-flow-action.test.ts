import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateEmailFlowAction } from "./channel-routing";

test("first dispatch and retry use only the exact case-bound Gateway A email identity", () => {
  const key = "gateway-a:42:offer-package:email";
  assert.equal(candidateEmailFlowAction(42, "email", key), "offer");
  for (const [caseId, channel, identity] of [
    [41, "email", key], [42, "whatsapp", key], [42, "email", `${key}:suffix`],
    [42, "email", "model-proposed-offer"], [42, "email", undefined],
  ] as const) assert.equal(candidateEmailFlowAction(caseId, channel, identity), "notification");
});
