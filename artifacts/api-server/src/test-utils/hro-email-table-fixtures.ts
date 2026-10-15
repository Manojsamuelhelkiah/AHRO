import { HRO_BATCH_TEMPLATES, type IntakeTemplate } from "../lib/onboarding/hro-batch-templates";
import { emailExample } from "../lib/hro-email-registry";

/** Sanitized reproduction: two rows, 19 columns, and flattened MIME alternative. */
export function tableEmailFixture(template: IntakeTemplate = HRO_BATCH_TEMPLATES[0]) {
  const fields = Object.fromEntries(emailExample(template).split("\n").map(line => {
    const colon = line.indexOf(":"); return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  Object.assign(fields, { request_id: "table-source-reference", worker_name: "Example Carter", worker_email: "example.carter@example.invalid", work_country: "USA",
    joining_date: "20-10-2026", worker_category: "External FTE", work_environment: "Office", site: "Example office",
    site_exposure: "Low", safety_critical: "No", assisted_intake: "Yes" });
  const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = `<table><tbody><tr>${template.columns.map(c => `<th>${escape(c.label)}</th>`).join("")}</tr><tr>${template.columns.map(c => `<td>${c.kind === "email" ? `<a href="mailto:${fields[c.key]}">${fields[c.key]}</a>` : escape(fields[c.key] ?? "")}</td>`).join("")}</tr></tbody></table>`;
  const plain = [...template.columns.map(c => c.label), ...template.columns.map(c => fields[c.key] ?? "")].join("\n");
  return { fields, html, plain };
}
