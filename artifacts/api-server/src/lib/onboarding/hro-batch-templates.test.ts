import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import express from "express";
import { HRO_BATCH_TEMPLATES, validateHroRows, hroRequestForRow, readHroBatchRequest, canonicalIntakeHash, policyWithoutBatchIntake, type IntakeTemplate } from "./hro-batch-templates";
import { buildHroTemplate, parseHroSpreadsheet, safeCsvCell, hroUploadMultipart, HRO_UPLOAD_MAX_BYTES } from "./hro-batch-files";

test("multipart accepts the exact template fields plus file while keeping extra-part and size limits", async () => {
  const app = express();
  app.post("/upload", (req, res) => hroUploadMultipart(req, res, error => {
    if (error) { res.status(400).json({ error: (error as { code?: string }).code }); return; }
    const result = { templateId: req.body.templateId, templateVersion: req.body.templateVersion, filename: req.file?.originalname };
    req.file?.buffer.fill(0);
    res.json(result);
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/upload`;
  const form = (bytes = Buffer.from("request_id\nTEST-001\n")) => {
    const data = new FormData();
    data.append("templateId", "payroll-bank-change");
    data.append("templateVersion", "1");
    data.append("file", new Blob([new Uint8Array(bytes)], { type: "text/csv" }), "cases.csv");
    return data;
  };
  try {
    const valid = await fetch(endpoint, { method: "POST", body: form() });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { templateId: "payroll-bank-change", templateVersion: "1", filename: "cases.csv" });
    const extra = form(); extra.append("unexpected", "rejected");
    assert.equal((await fetch(endpoint, { method: "POST", body: extra })).status, 400);
    const tooLarge = await fetch(endpoint, { method: "POST", body: form(Buffer.alloc(HRO_UPLOAD_MAX_BYTES + 1)) });
    assert.equal(tooLarge.status, 400);
    assert.equal((await tooLarge.json() as { error: string }).error, "LIMIT_FILE_SIZE");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

export function validTemplateRow(definition: IntakeTemplate, id = "REQ-001") {
  return Object.fromEntries(definition.columns.map(field => [field.key,
    field.key === "template_id" ? definition.id :
      field.key === "template_version" ? String(definition.version) :
        field.key === "request_id" ? id :
          field.key === "time_zone" ? "America/New_York" :
          field.kind === "email" ? "fixture@example.invalid" :
            field.kind === "country" ? "US" :
              field.kind === "date" ? "2031-01-10" :
                field.kind === "choice" ? field.values![0] : field.required ? `Fixture ${field.key}` : "",
  ]));
}
test("catalogue covers all twelve real case families with distinct versioned schemas", () => {
  assert.equal(new Set(HRO_BATCH_TEMPLATES.map(item => item.family)).size, 12);
  assert.equal(HRO_BATCH_TEMPLATES.length, 14);
  assert.equal(new Set(HRO_BATCH_TEMPLATES.map(item => item.id)).size, 14);
  for (const definition of HRO_BATCH_TEMPLATES) {
    const row = validTemplateRow(definition);
    assert.equal(validateHroRows(definition.id, definition.version, [row]).valid, true, definition.id);
    const request = hroRequestForRow(definition, row);
    assert.equal(readHroBatchRequest({ batchIntake: request })?.family, definition.family);
    assert.equal(request.executionMode, definition.hireType ? "onboarding-review" : "specialist-review-only");
    assert.equal(request.employeeReferenceStatus, definition.hireType ? "not-applicable" : "supplied-not-verified");
  }
});
test("wrong versions/types, unexpected private columns, formulas, duplicate references and impossible dates fail closed", () => {
  const definition = HRO_BATCH_TEMPLATES.find(item => item.id === "leave-request")!;
  const row = validTemplateRow(definition);
  for (const change of [{ template_version: "2" }, { template_id: "payroll-bank-change" }, { bank_account_number: "123456" }, { request_id: "=HYPERLINK(\"x\")" }, { end_date: "2031-02-30" }, { end_date: "2030-01-01" }, { worker_email: "not-email" }, { work_country: "us" }]) {
    assert.equal(validateHroRows(definition.id, 1, [{ ...row, ...change }]).valid, false);
  }
  assert.equal(validateHroRows(definition.id, 2, [row]).valid, false);
  assert.equal(validateHroRows(definition.id, 1, [row, row]).valid, false);
  assert.equal(validateHroRows(definition.id, 1, Array(501).fill(row)).valid, false);
  assert.equal(validateHroRows(definition.id, 1, [{ ...row, effective_date: 1 }]).valid, false);
});
test("canonical fingerprints ignore object key order and change when submitted facts change", () => {
  assert.equal(canonicalIntakeHash({ a: 1, b: 2 }), canonicalIntakeHash({ b: 2, a: 1 }));
  assert.notEqual(canonicalIntakeHash({ a: 1 }), canonicalIntakeHash({ a: 2 }));
  assert.equal(readHroBatchRequest({}), null);
  assert.deepEqual(policyWithoutBatchIntake({ profileId: "reviewed-policy", batchIntake: { data: { employee_id: "private" } } }), { profileId: "reviewed-policy" });
});
test("every XLSX/CSV template round-trips its headers and does not submit example people", async () => {
  for (const definition of HRO_BATCH_TEMPLATES) for (const format of ["csv", "xlsx"] as const) {
    const bytes = await buildHroTemplate(definition, format);
    const rows = await parseHroSpreadsheet(bytes, `template.${format}`);
    assert.equal(rows.length, 1, `${definition.id}.${format}`);
    assert.equal(rows[0].template_id, definition.id);
    assert.equal(rows[0].worker_name, "");
    assert.equal(validateHroRows(definition.id, 1, rows).valid, false);
    assert.deepEqual(Object.keys(rows[0]), definition.columns.map(item => item.key));
  }
});
test("populated XLSX preserves text employee IDs and rejects formulas", async () => {
  const definition = HRO_BATCH_TEMPLATES.find(item => item.id === "payroll-bank-change")!;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildHroTemplate(definition, "xlsx") as never);
  const sheet = book.getWorksheet("Cases")!;
  const row = { ...validTemplateRow(definition), employee_id: "000123" };
  definition.columns.forEach((field, index) => { sheet.getCell(2, index + 1).value = (row as Record<string, string>)[field.key]; });
  const parsed = await parseHroSpreadsheet(Buffer.from(await book.xlsx.writeBuffer()), "filled.xlsx");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].employee_id, "000123");
  assert.equal(validateHroRows(definition.id, 1, parsed).valid, true);
  sheet.getCell(2, 3).value = { formula: "1+1", result: 2 };
  await assert.rejects(parseHroSpreadsheet(Buffer.from(await book.xlsx.writeBuffer()), "formula.xlsx"), /not formulas/);
});
test("bad headers, unsupported files and oversized files never become requests", async () => {
  await assert.rejects(parseHroSpreadsheet(Buffer.from("x,x\na,b\n"), "bad.csv"), /unique/);
  await assert.rejects(parseHroSpreadsheet(Buffer.from("file"), "bad.xls"), /Only/);
  await assert.rejects(parseHroSpreadsheet(Buffer.alloc(2 * 1024 * 1024 + 1), "big.csv"), /2 MB/);
  await assert.rejects(parseHroSpreadsheet(Buffer.from("not a workbook"), "bad.xlsx"), /incomplete/);
  assert.match(safeCsvCell(" =1+1"), /'/);
});
