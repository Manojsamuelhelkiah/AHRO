import { Parser } from "htmlparser2";

export type EmailTable = { rows: string[][]; invalid: boolean };
export type EmailStructure = { tables: EmailTable[]; htmlText: string; issues: string[] };
/** Inert streaming tokenizer, not a browser DOM. Never resolves URLs or imports attachments.
 * Reject repaired/implicit cell layouts, spans, nested tables and incomplete markup.
 */
export function emailHtmlStructure(input: string): EmailStructure {
  const tables: EmailTable[] = [], issues: string[] = [];
  let table: EmailTable | undefined, row: string[] | undefined, cell: string | undefined;
  let tableDepth = 0, hidden = 0, text = "", tokens = 0;
  const stack: string[] = [];
  let limited = false;
  const parser = new Parser({
    onopentag(name, attrs, implied) {
      if (++tokens > 4096 || stack.length > 64) { limited = true; return; }
      stack.push(name);
      if (["script", "style", "iframe", "object"].includes(name)) hidden++;
      if (name === "table") {
        tableDepth++;
        if (table) table.invalid = true;
        else if (tables.length < 8) { table = { rows: [], invalid: Boolean(implied) }; tables.push(table); }
        else limited = true;
      }
      if (!table || tableDepth !== 1) return;
      if (name === "tr") {
        if (row || cell !== undefined || implied) table.invalid = true;
        row = [];
        if (table.rows.length >= 40) { limited = true; return; }
        table.rows.push(row);
      }
      if (name === "td" || name === "th") {
        if (!row || cell !== undefined || implied || attrs.rowspan || attrs.colspan) table.invalid = true;
        cell = "";
      }
      if (name === "br" && cell !== undefined) cell += "\n";
    },
    ontext(value) {
      if (hidden || limited) return;
      text += value;
      if (cell !== undefined && tableDepth === 1) cell += value;
    },
    onclosetag(name, implied) {
      if (limited) return;
      stack.pop();
      if (["script", "style", "iframe", "object"].includes(name)) hidden = Math.max(0, hidden - 1);
      if (table && ["tr", "td", "th", "table"].includes(name) && implied) table.invalid = true;
      if ((name === "td" || name === "th") && tableDepth === 1) {
        if (!row || cell === undefined || row.length >= 40) { if (table) table.invalid = true; }
        else row.push(cell.replace(/\u00a0/g, " ").trim());
        cell = undefined;
      }
      if (name === "tr" && tableDepth === 1) row = undefined;
      if (name === "table") {
        tableDepth--;
        if (!tableDepth) { table = undefined; row = undefined; cell = undefined; }
      }
      if (["p", "div", "li", "tr", "td", "th", "br"].includes(name)) text += "\n";
    },
  }, { decodeEntities: true });
  parser.write(input);
  parser.end();
  if (limited) { tables.forEach(t => { t.invalid = true; }); issues.push("HTML structure exceeds safe table processing limits."); }
  if (tables.some(t => t.invalid)) issues.push("Malformed, nested, merged or incomplete table. Supply a single header/value row or explicit key/value table.");
  return { tables, htmlText: text.replace(/\u0000/g, "").slice(0, 32768), issues };
}
