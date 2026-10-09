import ExcelJS from "exceljs";
import multer from "multer";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { type HroIntakeRow, type IntakeTemplate } from "./hro-batch-templates";

export const HRO_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
// Busboy emits partsLimit when the threshold is reached, not only exceeded.
// Allow the terminating boundary after our three expected parts. Independent
// fields/files limits still reject any additional submitted field or file.
export const hroUploadMultipart = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: HRO_UPLOAD_MAX_BYTES, files: 1, fields: 2, fieldSize: 200, parts: 4 },
}).single("file");
function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 400 }); }
export function safeCsvCell(value: string): string {
  const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
function boundedWorkbookZip(buffer: Buffer): void {
  if (buffer.readUInt32LE(0) !== 0x04034b50) fail("This is not an XLSX workbook.");
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) fail("Workbook ZIP directory is missing.");
  const entries = buffer.readUInt16LE(end + 10);
  if (entries > 100 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) fail("Use a small, ordinary workbook; archive variants are not supported.");
  let position = buffer.readUInt32LE(end + 16), expanded = 0;
  for (let i = 0; i < entries; i++) {
    if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) fail("Workbook ZIP directory is invalid.");
    const uncompressed = buffer.readUInt32LE(position + 24);
    const flags = buffer.readUInt16LE(position + 8);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30), commentLength = buffer.readUInt16LE(position + 32);
    if (flags & 1 || uncompressed === 0xffffffff) fail("Encrypted and ZIP64 workbooks are not supported.");
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString("utf8");
    if (/vbaProject|externalLinks|(?:^|\/)\.\.(?:\/|$)/i.test(name)) fail("Macros, external links and unsafe archive paths are not allowed.");
    const limit = 8 * 1024 * 1024;
    if (expanded + uncompressed > limit) fail("Expanded workbook is too large. Use a fresh template with at most 500 rows.");
    const local = buffer.readUInt32LE(position + 42), compressed = buffer.readUInt32LE(position + 20);
    const method = buffer.readUInt16LE(position + 10);
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) fail("Workbook entry is invalid.");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length || ![0, 8].includes(method)) fail("Workbook compression is invalid.");
    const content = buffer.subarray(start, start + compressed);
    const actualLength = method === 0 ? content.length : inflateRawSync(content, { maxOutputLength: Math.max(1, limit - expanded) }).length;
    if (actualLength !== uncompressed) fail("Workbook ZIP size declarations do not match.");
    expanded += actualLength;
    position += 46 + nameLength + extraLength + commentLength;
    if (position > buffer.length) fail("Workbook ZIP entry is invalid.");
  }
}
export async function parseHroSpreadsheet(buffer: Buffer, filename: string): Promise<HroIntakeRow[]> {
  if (!buffer.length || buffer.length > HRO_UPLOAD_MAX_BYTES) fail("Choose a non-empty Excel or CSV file no larger than 2 MB.");
  const workbook = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet | undefined;
  if (/\.xlsx$/i.test(filename)) {
    if (buffer.length < 22) fail("Workbook is incomplete.");
    boundedWorkbookZip(buffer);
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    sheet = workbook.getWorksheet("Cases");
    if (!sheet) fail("The workbook must contain the downloaded Cases worksheet.");
    if (workbook.worksheets.some(item => item.name !== "Cases" && item.name !== "Instructions" && item.actualRowCount > 0)) fail("Use only the Cases and Instructions worksheets from the template.");
  } else if (/\.csv$/i.test(filename)) {
    if (buffer.includes(0)) fail("CSV must be a UTF-8 text file.");
    sheet = await workbook.csv.read(Readable.from(buffer), {
      parserOptions: { maxRows: 502 },
      map: value => String(value ?? ""),
    });
  } else fail("Only .xlsx and .csv files are supported.");
  if (!sheet || sheet.rowCount < 2) fail("The file needs column headers and at least one request row.");
  let lastRow = 1;
  sheet.eachRow(row => { if (row.hasValues) lastRow = row.number; });
  if (lastRow > 501 || sheet.columnCount > 40) fail("Limit the template to 500 rows and its original columns.");
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, index) => {
    if (typeof cell.value !== "string") fail("Column headers must be plain text.");
    const value = cell.value.trim().replace(/^\uFEFF/, "");
    if (!value || headers.includes(value)) fail("Column headers must be non-empty and unique.");
    headers[index - 1] = value;
  });
  if (headers.length !== sheet.columnCount || headers.some(key => !/^[a-z][a-z0-9_]{0,63}$/.test(key))) fail("Keep the original template column names unchanged.");
  const rows: HroIntakeRow[] = [];
  for (let index = 2; index <= lastRow; index++) {
    const row = sheet.getRow(index), values: HroIntakeRow = {};
    for (let col = 1; col <= headers.length; col++) {
      const value = row.getCell(col).value, key = headers[col - 1];
      if (value === null) values[key] = "";
      else if (typeof value === "string") values[key] = value;
      else if (typeof value === "number" && key === "template_version") values[key] = String(value);
      else if (value instanceof Date && /_date$/.test(key) && Number.isFinite(value.getTime())) values[key] = value.toISOString().slice(0, 10);
      else fail(`Row ${index}, column ${key}: use plain text or an ISO date, not formulas, hyperlinks or numeric identifiers.`);
    }
    // Preserve spreadsheet row numbering: blank rows are invalid, not silently
    // discarded (which would move subsequent error locations).
    rows.push(values);
  }
  return rows;
}
export async function buildHroTemplate(definition: IntakeTemplate, format: "csv" | "xlsx"): Promise<Buffer> {
  const initial = definition.columns.map(field => field.key === "template_id" ? definition.id : field.key === "template_version" ? String(definition.version) : "");
  if (format === "csv") return Buffer.from("\uFEFF" + [definition.columns.map(field => safeCsvCell(field.key)).join(","), initial.map(safeCsvCell).join(",")].join("\r\n") + "\r\n");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Cases");
  sheet.columns = definition.columns.map(field => ({ header: field.key, key: field.key, width: Math.min(32, Math.max(16, field.key.length + 2)), style: { numFmt: "@" } }));
  sheet.addRow(initial);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };
  definition.columns.forEach((field, index) => {
    sheet.getRow(1).getCell(index + 1).note = `${field.required ? "Required. " : "Optional. "}${field.description}${field.values ? ` Allowed: ${field.values.join(", ")}.` : ""}`;
    if (field.values) for (let row = 2; row <= 501; row++) sheet.getCell(row, index + 1).dataValidation = { type: "list", allowBlank: !field.required, formulae: [`"${field.values.join(",")}"`], showErrorMessage: true, error: "Choose a value from the list." };
  });
  const guide = workbook.addWorksheet("Instructions");
  guide.columns = [{ width: 32 }, { width: 100 }];
  guide.addRows([
    ["Template", `${definition.family}: ${definition.name} (${definition.id}, version ${definition.version})`],
    ["Safety", definition.description],
    ["How to use", "Fill Cases only. Copy template_id and template_version to each populated row. Delete unused blank rows."],
    ["Limits", "500 requests, 2 MB. Keep IDs as text and dates YYYY-MM-DD. No formulas, hyperlinks, macros or extra columns."],
    ["Examples (fictional)", "request_id: REQ-EXAMPLE-001; worker_name: Example Worker; worker_email: person@example.invalid; work_country: IN; date: 2026-11-01. Do not submit these examples."],
    ["Privacy", "References only for protected documents/bank submissions. No bank numbers, diagnoses, document bodies or identity-document numbers."],
    ["Retention", "File bytes are parsed in memory and not retained. Approved case fields persist privately under the organization's lifecycle policy."],
    ...definition.columns.map(field => [field.key, `${field.required ? "Required" : "Optional"}; ${field.kind}. ${field.description} ${field.values ? `Values: ${field.values.join(", ")}` : ""}`]),
  ]);
  guide.eachRow(row => { row.alignment = { wrapText: true, vertical: "top" }; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
