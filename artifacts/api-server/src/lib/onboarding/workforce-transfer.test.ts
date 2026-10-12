import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { previewTransferRows, summarizeTransferPopulations } from "./workforce-transfer";
import {
  TRANSFER_RETENTION_RECORD_KIND,
  TRANSFER_RETENTION_TABLES,
  jurisdictionRecordId,
  scanTransferProgramPages,
  transferRetentionJobAction,
} from "./workforce-transfer-retention";

const mapping = {
  sourceWorkerId: "source_id",
  workerName: "name",
  workEmail: "email",
  originalHireDate: "hire",
  continuousServiceDate: "service",
  termsReference: "terms",
  compensationReference: "comp",
  benefitsReference: "benefits",
};

describe("workforce transfer import preview", () => {
  test("population totals include only readable countries and never infer unknown expectations", () => {
    const populations = [
      { country: "US", expectedHeadcount: 12, importedHeadcount: 3 },
      { country: "DE", expectedHeadcount: 99, importedHeadcount: 80 },
    ];
    assert.deepEqual(summarizeTransferPopulations(["US"], populations), { expectedHeadcount: 12, importedHeadcount: 3 });
    assert.deepEqual(summarizeTransferPopulations(["US", "CA"], populations), { expectedHeadcount: null, importedHeadcount: 3 });
    assert.deepEqual(summarizeTransferPopulations(["CA"], populations), { expectedHeadcount: null, importedHeadcount: 0 });
    assert.deepEqual(summarizeTransferPopulations(["US"], [{ country: "US", expectedHeadcount: null, importedHeadcount: 3 }]), { expectedHeadcount: null, importedHeadcount: 3 });
    assert.deepEqual(summarizeTransferPopulations(["US"], [{ country: "US", expectedHeadcount: 0, importedHeadcount: 0 }]), { expectedHeadcount: 0, importedHeadcount: 0 });
  });
  test("retention custody inventories every durable transfer representation", () => {
    assert.equal(TRANSFER_RETENTION_TABLES.length, 17);
    assert.equal(new Set(TRANSFER_RETENTION_TABLES).size, 17);
    assert.equal(TRANSFER_RETENTION_RECORD_KIND, "transfer-program");
    assert.ok(TRANSFER_RETENTION_TABLES.includes("onb_transfer_workers"));
    assert.ok(TRANSFER_RETENTION_TABLES.includes("onb_transfer_cutover_reconciliations"));
    assert.ok(TRANSFER_RETENTION_TABLES.includes("onb_transfer_kpi_evidence"));
    assert.ok(TRANSFER_RETENTION_TABLES.includes("onb_transfer_operational_supersessions"));
  });

  test("refreshes stale blocked custody jobs with current reviewed policies", () => {
    assert.equal(transferRetentionJobAction(
      [{ status: "blocked", policyId: 7, policyRevision: 3 }],
      { id: 7, revision: 3 },
    ), "refresh");
    assert.equal(transferRetentionJobAction(
      [{ status: "blocked", policyId: 7, policyRevision: 3 }],
      { id: 8, revision: 1 },
    ), "create");
    assert.equal(transferRetentionJobAction(
      [{ status: "queued", policyId: 7, policyRevision: 3 }],
      { id: 7, revision: 3 },
    ), "skip");
  });

  test("uses distinct jurisdiction records so one country can expire without deleting another", () => {
    const us = jurisdictionRecordId("program:with/slashes", "US");
    const ca = jurisdictionRecordId("program:with/slashes", "CA");
    assert.notEqual(us, ca);
    assert.equal(us, "transfer-jurisdiction:program%3Awith%2Fslashes:US");
    assert.match(ca, /:CA$/);
  });

  test("keyset scan reaches a due program after more than 100 ineligible programs", async () => {
    const createdAt = new Date("2020-01-01T00:00:00.000Z");
    const programs = Array.from({ length: 102 }, (_, index) => ({
      id: String(index).padStart(3, "0"),
      createdAt,
      eligible: index === 101,
    }));
    const visited: string[] = [];
    await scanTransferProgramPages(
      100,
      async (cursor) => programs.filter((program) =>
        !cursor || program.id > cursor.id,
      ).slice(0, 100),
      async (program) => {
        if (program.eligible) visited.push(program.id);
      },
    );
    assert.deepEqual(visited, ["101"]);
  });

  test("requires the stable worker key and retained service dates", () => {
    const preview = previewTransferRows(mapping, [{
      source_id: "source-1", name: "Worker", email: "worker@example.test",
      hire: "2024-01-02T00:00:00.000Z", service: "2023-01-02T00:00:00.000Z",
      terms: "terms-v1", comp: "comp-v1", benefits: "benefits-v1",
    }]);
    assert.equal(preview.normalizedRows.length, 1);
    assert.match(preview.errors[0]!.message, /continuousServiceDate cannot precede/);
  });

  test("detects duplicate source-worker keys before any sensitive rows persist", () => {
    const rows = [
      { source_id: "source-1", name: "Worker One", email: "one@example.test", hire: "2023-01-02T00:00:00.000Z", service: "2023-01-02T00:00:00.000Z", terms: "terms-v1", comp: "comp-v1", benefits: "benefits-v1" },
      { source_id: "source-1", name: "Worker Two", email: "two@example.test", hire: "2023-01-02T00:00:00.000Z", service: "2023-01-02T00:00:00.000Z", terms: "terms-v1", comp: "comp-v1", benefits: "benefits-v1" },
    ];
    const preview = previewTransferRows(mapping, rows);
    assert.equal(preview.normalizedRows.length, 2);
    assert.equal(preview.errors.filter((error) => /duplicate .*sourceWorkerId/i.test(error.message)).length, 1);
  });

  test("creates a stable fingerprint independent of source-row ordering", () => {
    const one = { source_id: "source-1", name: "Worker One", email: "one@example.test", hire: "2023-01-02T00:00:00.000Z", service: "2023-01-02T00:00:00.000Z", terms: "terms-v1", comp: "comp-v1", benefits: "benefits-v1" };
    const two = { source_id: "source-2", name: "Worker Two", email: "two@example.test", hire: "2023-01-02T00:00:00.000Z", service: "2023-01-02T00:00:00.000Z", terms: "terms-v1", comp: "comp-v1", benefits: "benefits-v1" };
    assert.equal(previewTransferRows(mapping, [one, two]).fingerprint, previewTransferRows(mapping, [two, one]).fingerprint);
  });
});