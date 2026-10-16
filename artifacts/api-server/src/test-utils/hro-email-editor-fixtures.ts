/**
 * Hand-authored, sanitized editor-shaped compatibility corpus, not vendor exports
 * or a claim to support every editor version. All addresses/resources use .invalid.
 * Pinned source labels/values intentionally do not follow registry-generated examples.
 * See hro-email-editor-fixtures.md for the supported/review-required matrix.
 */
export const editorFields: Record<string, string> = {
  template_id: "onboarding-external-fte", template_version: "1", request_id: "editor-source",
  worker_name: "Example Rowan", worker_email: "rowan@example.invalid", work_country: "US",
  legal_entity: "Example & Company", department: "People Operations", role: "Example role",
  manager_name: "Example Manager", recruiter_name: "Example Recruiter", joining_date: "2026-10-20",
  worker_category: "employee", work_environment: "office", site: "Example office",
  site_exposure: "no", safety_critical: "no", assisted_intake: "yes",
};
const labels = ["Template ID", "Template version", "Request ID", "Worker name", "Worker email",
  "Work country", "Legal entity", "Department", "Role", "Manager name", "Recruiter name",
  "Joining date", "Worker category", "Job profile ID", "Work environment", "Site",
  "site exposure", "safety critical", "assisted intake"];
const values = ["onboarding-external-fte", "1", "editor-source", "Example Rowan", "rowan@example.invalid",
  "USA", "Example &amp; Company", "People&nbsp;Operations", "Example role", "Example Manager",
  "Example Recruiter", "20-10-2026", "Employee", "", "Office", "Example office", "No", "No", "Yes"];
const row = `<tr>${values.map(v => `<td>${v}</td>`).join("")}</tr>`;
const table = `<table><tbody><tr>${labels.map(v => `<th>${v}</th>`).join("")}</tr>${row}</tbody></table>`;
export const editorPlain = Object.entries(editorFields).map(([k, v]) => `${k}: ${v}`).join("\r\n");
export type EditorFixture = {
  id: string;
  editor: "Gmail" | "Outlook" | "Apple Mail";
  expectation: "supported" | "review-required";
  reason: string;
  html: string;
  expectedFields: Record<string, string>;
  issue?: { field: string; kind: string };
};
const wrappers = {
  Gmail: (html: string) => `<div dir="ltr"><div class="gmail_default" style="font-family:arial">${html}</div><div><br></div></div>`,
  Outlook: (html: string) => `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>.MsoNormal{font-size:11pt}</style></head><body><div class="WordSection1"><p class="MsoNormal"><o:p>&nbsp;</o:p></p>${html}</div></body></html>`,
  "Apple Mail": (html: string) => `<html><body style="overflow-wrap:break-word"><div class="AppleOriginalContents">${html}</div><br class="Apple-interchange-newline"></body></html>`,
};
const quote = {
  Gmail: (html: string) => `<div class="gmail_quote"><div class="gmail_attr">On a previous day, Example wrote:</div><blockquote class="gmail_quote">${html}</blockquote></div>`,
  Outlook: (html: string) => `<div id="divRplyFwdMsg"><p>-----Original Message-----</p><p>From: archive@example.invalid</p></div><div>${html}</div>`,
  "Apple Mail": (html: string) => `<div>Begin forwarded message:</div><blockquote type="cite">${html}</blockquote>`,
};
export const editorFixtures: EditorFixture[] = (Object.keys(wrappers) as Array<keyof typeof wrappers>).flatMap(editor => [
  {
    id: `${editor}-wrapped`, editor, expectation: "supported",
    reason: "One explicit employee table; wrappers, spans, entities and mailto display text preserve fields.",
    html: wrappers[editor](table.replaceAll("<td>", '<td style="padding:0"><span>')
      .replaceAll("</td>", "</span></td>").replace("rowan@example.invalid",
        '<a href="mailto:rowan@example.invalid">rowan&#64;example.invalid</a>')),
    expectedFields: editorFields,
  },
  {
    id: `${editor}-quoted-template`, editor, expectation: "review-required",
    reason: "A current table and quoted/forwarded employee template must never be combined, even for disjoint optional fields.",
    html: wrappers[editor](table + quote[editor](table.replace("Example Rowan", "Example Quoted")
      .replace("<td></td>", "<td>quoted-profile-only</td>").replace("rowan@example.invalid", "quoted@example.invalid"))),
    expectedFields: {}, issue: { field: "table", kind: "ambiguous" },
  },
  {
    id: `${editor}-unrelated-quote`, editor, expectation: "review-required",
    reason: "Unrelated quoted table is a visible unsupported layout, not an additional source of employee facts.",
    html: wrappers[editor](table + quote[editor]('<table><tr><td>Travel preference</td><td>Quoted-only destination</td></tr></table>')),
    expectedFields: editorFields, issue: { field: "table", kind: "ambiguous" },
  },
  {
    id: `${editor}-multiple-employees`, editor, expectation: "review-required",
    reason: "Two employee value rows must not collapse into one record.",
    html: wrappers[editor](table.replace("</tbody>", row.replace("Example Rowan", "Example Second") + "</tbody>")),
    expectedFields: {}, issue: { field: "table", kind: "ambiguous" },
  },
  {
    id: `${editor}-layout-table`, editor, expectation: "review-required",
    reason: "Editor layout table nesting is deliberately unsupported; no implicit browser repair or flattening.",
    html: wrappers[editor](`<table><tr><td>${table}</td></tr></table>`),
    expectedFields: {}, issue: { field: "table", kind: "malformed" },
  },
]);
