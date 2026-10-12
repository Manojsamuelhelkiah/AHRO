import { createRequire } from "node:module";
import { resolve } from "node:path";
import { copyFile } from "node:fs/promises";
const require = createRequire(resolve("artifacts/api-server/package.json"));
const ExcelJS = require("exceljs");
const replacements = new Map([
  ["Demo / simulation", "Historical record protections"],
  ["Demo/simulation layer", "Historical record protections"],
  ["Demo login, simulated calls and hire replies, seeded volunteers (optional for production)", "Restricted login and read-only history; permanent offline dispatch denial"],
  ["Simulated calls and hire replies, seeded demo data (sales demos; optional for production)", "Restricted evidence access, permanent offline protections, provenance and exclusion from live outcomes"],
  ["Demo login, fictional offline calls and hire replies; no volunteer outreach", "Restricted login and read-only history; permanent offline dispatch denial"],
  ["simulated calls and hire replies, seeded demo data (needed for sales demos; optional for production)", "Restricted evidence access, permanent offline protections, provenance and exclusion from live outcomes"],
]);
const book = new ExcelJS.Workbook();
await book.xlsx.readFile("docs/hro-app-component-inventory.xlsx");
book.eachSheet(sheet => sheet.eachRow(row => row.eachCell(cell => {
  if (typeof cell.value !== "string") return;
  for (const [oldText, newText] of replacements) cell.value = cell.value.replaceAll(oldText, newText);
})));
await book.xlsx.writeFile("docs/hro-app-component-inventory.xlsx");
await copyFile("docs/hro-app-component-inventory.xlsx", "artifacts/onboarding-agent/public/hro-app-component-inventory.xlsx");
