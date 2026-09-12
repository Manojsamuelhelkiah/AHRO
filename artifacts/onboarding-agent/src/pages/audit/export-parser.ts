export const PROTECTED_AUDIT_CSV_HEADER = [
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
] as const;

const FOOTER_LINE_COUNT = 7;

export class AuditExportFormatError extends Error {
  constructor(message: string) {
    super(`Invalid protected audit CSV: ${message}`);
    this.name = "AuditExportFormatError";
  }
}

export type ProtectedAuditCsvFooter = {
  /** Stable verification fields; checked_entries is intentionally omitted. */
  stableIntegrityLines: readonly string[];
  integrityLines: readonly string[];
  checkedEntries: number;
  truncated: boolean;
  nextCursor: number | null;
  lines: readonly string[];
};

export type ProtectedAuditCsvPage = {
  header: string;
  rows: string;
  footer: ProtectedAuditCsvFooter;
};

function parseBoolean(line: string, name: string): boolean {
  const match = line.match(new RegExp(`^# ${name}=(true|false)$`));
  if (!match) {
    throw new AuditExportFormatError(`missing or invalid ${name} footer.`);
  }
  return match[1] === "true";
}

function parseNonNegativeInteger(line: string, name: string): number {
  const match = line.match(new RegExp(`^# ${name}=([0-9]+)$`));
  if (!match) {
    throw new AuditExportFormatError(`missing or invalid ${name} footer.`);
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AuditExportFormatError(`${name} is outside the safe integer range.`);
  }
  return value;
}

function parseNextCursor(line: string): number | null {
  const match = line.match(/^# next_cursor=(.*)$/);
  if (!match) {
    throw new AuditExportFormatError("missing next_cursor footer.");
  }
  if (match[1] === "") return null;
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuditExportFormatError("next_cursor must be a positive safe integer.");
  }
  return value;
}

/**
 * Parse the exact page format emitted by /onboarding/audit/export.
 *
 * Rows are kept as text rather than split on commas. This preserves quoted
 * values (including quoted newlines) while allowing pages to be joined
 * without rewriting the server's CSV encoding.
 */
export function parseProtectedAuditCsvPage(csvText: string): ProtectedAuditCsvPage {
  if (typeof csvText !== "string" || csvText.length === 0) {
    throw new AuditExportFormatError("response is empty.");
  }

  const normalized = csvText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  // The route does not append a newline, but accepting one makes the parser
  // tolerant of a proxy adding the conventional final line ending.
  if (lines.at(-1) === "") lines.pop();

  const header = PROTECTED_AUDIT_CSV_HEADER.join(",");
  if (lines[0] !== header) {
    throw new AuditExportFormatError("CSV header does not match the audit export contract.");
  }
  if (lines.length < 1 + FOOTER_LINE_COUNT) {
    throw new AuditExportFormatError("required footer is missing.");
  }

  const footerStart = lines.length - FOOTER_LINE_COUNT;
  const footerLines = lines.slice(footerStart);
  const status = footerLines[0].match(/^# integrity_status=(empty|verified|broken)$/);
  if (!status) {
    throw new AuditExportFormatError("missing or invalid integrity_status footer.");
  }
  if (footerLines[2] !== "# external_anchoring_required_for_launch=true") {
    throw new AuditExportFormatError("external anchoring launch requirement footer is invalid.");
  }
  const checkedEntries = parseNonNegativeInteger(footerLines[1], "checked_entries");
  parseBoolean(footerLines[3], "external_anchoring_configured");
  if (footerLines[4] !== "# export_page_limit=500") {
    throw new AuditExportFormatError("export page limit footer is invalid.");
  }
  const truncated = parseBoolean(footerLines[5], "export_truncated");
  const nextCursor = parseNextCursor(footerLines[6]);
  if (truncated !== (nextCursor !== null)) {
    throw new AuditExportFormatError(
      "export_truncated and next_cursor disagree; refusing to continue.",
    );
  }

  const rows = lines.slice(1, footerStart).join("\n");
  return {
    header,
    rows,
    footer: {
      stableIntegrityLines: [
        footerLines[0],
        footerLines[2],
        footerLines[3],
        footerLines[4],
      ],
      integrityLines: footerLines.slice(0, 5),
      checkedEntries,
      truncated,
      nextCursor,
      lines: footerLines,
    },
  };
}

/**
 * Gather all pages emitted by /onboarding/audit/export.
 *
 * The route records the export request itself before returning a page. That
 * means checked_entries is a per-response verification count and may increase
 * between requests; it must not be treated as an immutable export-row count.
 * The server's sequence cursor is the continuation window. We require it to
 * move strictly forward and preserve the final response's complete footer so
 * its verification metadata remains truthful.
 */
export async function collectProtectedAuditCsv(
  fetchPage: (cursor?: number) => Promise<string>,
): Promise<string> {
  const pageRows: string[] = [];
  const visitedCursors = new Set<number>();
  let currentCursor: number | undefined;
  let header: string | null = null;
  let finalFooter: readonly string[] | null = null;
  let stableIntegrity: string | null = null;

  while (true) {
    const parsed = parseProtectedAuditCsvPage(await fetchPage(currentCursor));
    if (header === null) {
      header = parsed.header;
      stableIntegrity = parsed.footer.stableIntegrityLines.join("\n");
    } else if (parsed.header !== header) {
      throw new AuditExportFormatError("continuation page header does not match the first page.");
    } else if (parsed.footer.stableIntegrityLines.join("\n") !== stableIntegrity) {
      throw new AuditExportFormatError(
        "continuation page integrity metadata does not match the first page.",
      );
    }

    if (parsed.rows) pageRows.push(parsed.rows);
    finalFooter = parsed.footer.lines;
    if (parsed.footer.nextCursor === null) break;

    const nextCursor = parsed.footer.nextCursor;
    if (currentCursor !== undefined && nextCursor <= currentCursor) {
      throw new AuditExportFormatError(
        "continuation cursor did not move forward; refusing to continue.",
      );
    }
    if (visitedCursors.has(nextCursor)) {
      throw new AuditExportFormatError("continuation cursor repeated; refusing to loop.");
    }
    visitedCursors.add(nextCursor);
    currentCursor = nextCursor;
  }

  if (!header || !finalFooter) {
    throw new AuditExportFormatError("export did not contain a complete page.");
  }
  return [header, ...pageRows, ...finalFooter].join("\n");
}