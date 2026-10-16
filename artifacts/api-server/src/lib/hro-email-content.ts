import type { GmailMessage } from "./onboarding/inbound-email";
import { emailHtmlStructure, type EmailStructure } from "./hro-email-structure";

export const MAX_EMAIL_BYTES = 32_768;
/** Never recurse into attached message/rfc822 or fetch remote URLs. Reject MIME bombs before decoding. */
export function boundedEmailContent(msg: GmailMessage): { body: string; structure: EmailStructure; scanContent: string; attachments: Array<{ name: string; status: string }>; blocked: boolean } {
  let nodes = 0, bytes = 0, blocked = false;
  const plain: string[] = [], html: string[] = [], attachments: Array<{ name: string; status: string }> = [];
  function walk(part: GmailMessage["payload"], depth: number) {
    if (!part || blocked) return;
    if (++nodes > 100 || depth > 12) { blocked = true; return; }
    if (part.filename || part.mimeType === "message/rfc822") {
      if (attachments.length >= 10) { blocked = true; return; }
      attachments.push({ name: "Private provider attachment", status: "quarantined-not-imported" });
      return;
    }
    if (part.body?.data && (part.mimeType === "text/plain" || part.mimeType === "text/html" || !part.mimeType)) {
      if (part.body.data.length > MAX_EMAIL_BYTES * 1.4) { blocked = true; return; }
      const b = Buffer.from(part.body.data, "base64url");
      bytes += b.length;
      if (bytes > MAX_EMAIL_BYTES) { b.fill(0); blocked = true; return; }
      const text = b.toString("utf8"); b.fill(0);
      if (part.mimeType === "text/html") html.push(text); else plain.push(text);
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  }
  walk(msg.payload, 0);
  const structures = blocked ? [] : html.map(emailHtmlStructure);
  const structure = { tables: structures.flatMap(s => s.tables), htmlText: structures.map(s => s.htmlText).join("\n"), issues: structures.flatMap(s => s.issues) };
  if (structure.tables.length > 8) { blocked = true; structure.tables = []; }
  const body = plain.length ? plain.join("\n") : structure.htmlText;
  return { body: blocked ? "" : body.replace(/\u0000/g, "").slice(0, MAX_EMAIL_BYTES),
    structure: blocked ? { tables: [], htmlText: "", issues: [] } : structure,
    scanContent: blocked ? "" : [...plain, ...html].join("\n"), attachments, blocked };
}
