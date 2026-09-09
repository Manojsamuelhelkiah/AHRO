export const MAX_SCENARIO_FILE_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_SCENARIO_FILES = {
  ".json": ["application/json"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown"],
  ".pdf": "application/pdf",
  ".csv": ["text/csv"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ".bpmn": ["application/xml", "text/xml"],
  ".xml": ["application/xml", "text/xml"],
} as const;

export type SupportedScenarioFile = {
  extension: keyof typeof SUPPORTED_SCENARIO_FILES;
  contentType: string;
};

function parseCsvCells(text: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"' && cell.trim().length === 0) {
      quoted = true;
    } else if (character === "," || character === "\n" || character === "\r") {
      cells.push(cell);
      cell = "";
      if (character === "\r" && text[index + 1] === "\n") index += 1;
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function isUnsafeSpreadsheetFormula(cell: string): boolean {
  const value = cell.trim();
  if (!/^[=+\-@]/.test(value)) return false;
  const signedNumber = /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/i;
  return !signedNumber.test(value);
}

export function validateDeclaredScenarioFile(
  name: string,
  contentType: string,
  size: number,
): SupportedScenarioFile {
  const normalizedName = name.trim();
  const extension = normalizedName.slice(normalizedName.lastIndexOf(".")).toLowerCase() as keyof typeof SUPPORTED_SCENARIO_FILES;
  const allowed = SUPPORTED_SCENARIO_FILES[extension];
  const expected = typeof allowed === "string" ? [allowed] : allowed;
  if (!expected || !expected.includes(contentType.toLowerCase() as never)) {
    throw new Error("Supported files are JSON, CSV, TXT, MD, PDF, DOCX, BPMN, or XML with matching MIME types");
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_SCENARIO_FILE_BYTES) {
    throw new Error("File size must be between 1 byte and 10 MB");
  }
  if (normalizedName.length > 255 || /[\/\\\0]/.test(normalizedName)) {
    throw new Error("File name is invalid");
  }
  return { extension, contentType: contentType.toLowerCase() };
}

export function validateScenarioFileContent(
  extension: SupportedScenarioFile["extension"],
  bytes: Buffer,
): void {
  if (extension === ".pdf") {
    if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("PDF signature is invalid");
    }
    const source = bytes.toString("latin1");
    if (/\/(?:JavaScript|JS|Launch|EmbeddedFile)\b/i.test(source)) {
      throw new Error("PDF contains active or embedded content");
    }
    return;
  }
  if (extension === ".docx") {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b ||
        !((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))) {
      throw new Error("DOCX container signature is invalid");
    }
    const packageIndex = bytes.toString("latin1");
    if (!packageIndex.includes("[Content_Types].xml")) {
      throw new Error("DOCX package structure is invalid");
    }
    if (!packageIndex.includes("word/document.xml")) {
      throw new Error("DOCX package structure is invalid");
    }
    if (/vbaProject\.bin|externalLinks?|https?:\/\//i.test(packageIndex)) {
      throw new Error("DOCX contains macros or external links");
    }
    return;
  }
  if (bytes.includes(0)) throw new Error("Text-based files must not contain binary data");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (extension === ".json") {
    try { JSON.parse(text); } catch { throw new Error("JSON content is invalid"); }
  }
  if (extension === ".xml" || extension === ".bpmn") {
    if (
      !/^\s*(?:<\?xml[\s\S]*?\?>\s*)?<[A-Za-z_]/.test(text) ||
      /<!doctype|<!entity|xinclude:include|<script\b|(?:^|[\s<])on[a-z][\w:.-]*\s*=/i.test(text)
    ) {
      throw new Error("XML contains unsafe or invalid content");
    }
  }
  if (extension === ".csv") {
    if (/<script\b/i.test(text)) {
      throw new Error("CSV contains unsafe active content");
    }
    if (parseCsvCells(text).some(isUnsafeSpreadsheetFormula)) {
      throw new Error("CSV contains an unsafe spreadsheet formula");
    }
  }
}