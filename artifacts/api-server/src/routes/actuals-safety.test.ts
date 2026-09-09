import test from "node:test";
import assert from "node:assert/strict";
import {
  loadCustomIntentsWhenRequired,
  overlayRequiresCustomIntentLookup,
} from "./actuals.js";
import { aggregateCallLog } from "../lib/aggregate-log.js";
import {
  CUSTOM_INTENT_STORAGE_UNAVAILABLE_CODE,
  CUSTOM_INTENT_STORAGE_UNAVAILABLE_MESSAGE,
  CustomIntentStorageUnavailableError,
  errorHandler,
} from "../middlewares/error-handler.js";
import type { NextFunction, Request, Response } from "express";

test("reference-only overlays do not require custom-intent storage", () => {
  assert.equal(overlayRequiresCustomIntentLookup({
    measuredContainmentByFlowClass: { "fc1-deterministic": 0.8 },
    measuredHitlSamplingRate: 0.1,
  }), false);
});

test("built-in per-intent overlays do not require custom-intent storage", () => {
  assert.equal(overlayRequiresCustomIntentLookup({
    intents: [{ intentKey: "payslip-copy", measuredContainmentRate: 0.8 }],
  }), false);
});

test("custom or unknown per-intent overlays require custom-intent storage", () => {
  assert.equal(overlayRequiresCustomIntentLookup({
    intents: [{ intentKey: "custom-payroll", measuredContainmentRate: 0.8 }],
  }), true);
});

test("call-log aggregation recognizes loaded custom intents", () => {
  const csv = "call_id,intent_key,contained\n1,custom-payroll,true\n";
  const result = aggregateCallLog(csv, [{
    id: -1,
    key: "custom-payroll",
    name: "Custom payroll",
    domain: "Payroll",
    flowClass: "fc2-policy",
    description: "Custom",
    source: { name: "Test", confidence: "medium" },
    asIsHandlingMin: 5,
    toBeHumanMin: 1,
    baseWeight: 1,
    actGetActions: 1,
    actPutActions: 0,
    systemsTouchedBase: 1,
    tags: ["custom"],
  }]);
  assert.deepEqual(result.unknownIntents, []);
  assert.equal(result.proposedOverlay.intents?.[0]?.intentKey, "custom-payroll");
  assert.equal(result.proposedOverlay.measuredContainmentByFlowClass?.["fc2-policy"], 1);
});

test("reference-only calibration bypasses unavailable custom-intent storage", async () => {
  let loadCalled = false;
  const intents = await loadCustomIntentsWhenRequired(false, async () => {
    loadCalled = true;
    throw new Error("storage unavailable");
  });

  assert.deepEqual(intents, []);
  assert.equal(loadCalled, false);
});

test("custom-intent-dependent calibration maps storage failures to the availability error", async () => {
  await assert.rejects(
    loadCustomIntentsWhenRequired(true, async () => {
      throw new Error("storage unavailable");
    }),
    CustomIntentStorageUnavailableError,
  );
});

test("custom-intent storage failures return the stable retryable response contract", () => {
  let statusCode: number | undefined;
  let body: unknown;
  const response = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;

  errorHandler(
    new CustomIntentStorageUnavailableError({ cause: new Error("database offline") }),
    {} as Request,
    response,
    (() => undefined) as NextFunction,
  );

  assert.equal(statusCode, 503);
  assert.deepEqual(body, {
    error: CUSTOM_INTENT_STORAGE_UNAVAILABLE_MESSAGE,
    code: CUSTOM_INTENT_STORAGE_UNAVAILABLE_CODE,
  });
});