import assert from "node:assert/strict";
import test from "node:test";
import {
  AuditExportFormatError,
  collectProtectedAuditCsv,
  parseProtectedAuditCsvPage,
} from "./export-parser";

const header = [
  "sequence",
  "occurredAt",
  "actorId",
  "actorKind",
  "actorAuthority",
  "action",
  "outcome",
  "objectType",
  "objectId",
  "caseReference",
  "reviewedRevision",
  "source",
  "correlationId",
  "correctionOfId",
  "previousHash",
  "entryHash",
].join(",");

function page({
  sequence = "1",
  checkedEntries = 1,
  truncated = false,
  cursor = "",
} = {}) {
  return [
    header,
    // The quoted action contains a newline; parsing must not treat it as a
    // page/footer boundary.
    `"${sequence}","2025-01-01T00:00:00.000Z","actor","authenticated","tenant-membership:owner","line\nbreak","success","approval","ref:abc","","","http","","","","hash"`,
    "# integrity_status=verified",
    `# checked_entries=${checkedEntries}`,
    "# external_anchoring_required_for_launch=true",
    "# external_anchoring_configured=false",
    "# export_page_limit=500",
    `# export_truncated=${truncated}`,
    `# next_cursor=${cursor}`,
  ].join("\n");
}

test("parses the protected audit footer and preserves CSV rows", () => {
  const parsed = parseProtectedAuditCsvPage(page({ truncated: true, cursor: "42" }));
  assert.equal(parsed.rows.includes('"line\nbreak"'), true);
  assert.equal(parsed.footer.truncated, true);
  assert.equal(parsed.footer.nextCursor, 42);
  assert.deepEqual(parsed.footer.integrityLines, [
    "# integrity_status=verified",
    "# checked_entries=1",
    "# external_anchoring_required_for_launch=true",
    "# external_anchoring_configured=false",
    "# export_page_limit=500",
  ]);
});

test("rejects a truncated page without a continuation cursor", () => {
  assert.throws(
    () => parseProtectedAuditCsvPage(page({ truncated: true })),
    AuditExportFormatError,
  );
});

test("rejects a page with a malformed footer", () => {
  assert.throws(
    () => parseProtectedAuditCsvPage(page().replace("# export_page_limit=500", "# export_page_limit=50")),
    AuditExportFormatError,
  );
});

test("coordinates multiple requests when checked_entries grows per export request", async () => {
  const requestedCursors: Array<number | undefined> = [];
  const pages = [
    page({ sequence: "1", checkedEntries: 2, truncated: true, cursor: "1" }),
    page({ sequence: "2", checkedEntries: 3 }),
  ];
  let pageIndex = 0;

  const csv = await collectProtectedAuditCsv(async (cursor) => {
    requestedCursors.push(cursor);
    const next = pages[pageIndex++];
    if (!next) throw new Error("unexpected extra continuation request");
    return next;
  });

  assert.deepEqual(requestedCursors, [undefined, 1]);
  assert.equal(csv.split(header).length - 1, 1);
  assert.equal(csv.includes("# checked_entries=2"), false);
  assert.equal(csv.includes("# checked_entries=3"), true);
  assert.equal(csv.includes("# export_truncated=false"), true);
});