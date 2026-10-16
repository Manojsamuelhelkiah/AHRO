// Produces a portable, self-contained reading/download copy. Generated output
// stays in the already-ignored generated-artifacts directory, not Git.
import fs from "node:fs";
import path from "node:path";
const dir = "research/current-intent-agent-review";
const out = "generated-artifacts/hro-intent-agent-review";
fs.mkdirSync(out, { recursive: true });
const read = name => fs.readFileSync(path.join(dir, name), "utf8");
const data = JSON.parse(read("intent-agent-matrix.json"));
const esc = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const sections = {
  "README.md": "assessment", "review-tables.md": "tables",
  "capability-ledger.md": "capabilities",
};
function inline(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, title, link) => {
      const target = sections[link];
      const download = ["intent-agent-matrix.json", "intent-agent-matrix.csv", "gap-register.json", "reconciliation-results.json"].includes(link);
      return target ? `<a href="#${target}">${title}</a>` : download
        ? `<a href="#downloads">${title}</a>` : `${title} <small>(${link})</small>`;
    });
}
// Deliberately limited to the Markdown constructs used in this package.
function markdown(text) {
  const result = []; const lines = text.split("\n");
  let code = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) { result.push(code ? "</code></pre>" : "<pre><code>"); code = !code; continue; }
    if (code) { result.push(esc(line) + "\n"); continue; }
    if (line.startsWith("|")) {
      const table = [];
      while (i < lines.length && lines[i].startsWith("|")) table.push(lines[i++]);
      i--;
      result.push('<div class="table"><table>');
      for (let n = 0; n < table.length; n++) {
        if (/^\|[- :|]+\|$/.test(table[n])) continue;
        const tag = n === 0 ? "th" : "td";
        result.push("<tr>" + table[n].slice(1, -1).split("|").map(c => `<${tag}>${inline(c.trim())}</${tag}>`).join("") + "</tr>");
      }
      result.push("</table></div>"); continue;
    }
    const heading = line.match(/^(#{1,6}) (.*)/);
    if (heading) { result.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^- /.test(line)) result.push(`<p class="bullet">• ${inline(line.slice(2))}</p>`);
    else if (line.startsWith("> ")) result.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) result.push(`<p>${inline(line)}</p>`);
  }
  if (code) throw new Error("Unclosed report code block");
  return result.join("\n");
}
function download(name, mime) {
  return `<a class="download" download="${name}" href="data:${mime};base64,${Buffer.from(read(name)).toString("base64")}">Download ${esc(name)}</a>`;
}
const details = data.definitions.map(row => `<details><summary><code>${esc(row.intentKey)}</code> — ${esc(row.name)}</summary>
  <p><strong>Class/version:</strong> ${esc(row.definitionClass)} / ${esc(row.definitionVersion)}</p>
  <p><strong>Journey/services:</strong> ${esc(row.journeyKeys.join(", "))} / ${esc(row.serviceKeys.join(", "))}</p>
  <p><strong>Catalogued outcome:</strong> ${esc(row.observableOutcomeAsCatalogued)}</p>
  <p><strong>Source:</strong> ${esc(row.sourceVersion)}; ${esc(row.sourceOutcomeKeys.join(", "))}</p>
  <p><strong>Current role associations:</strong> ${esc(row.currentCatalogueAssociations.join(", ") || "None")}</p>
  <p><strong>Proposed coordinator:</strong> ${esc(row.proposedAccountableCoordinatingRole)}</p>
  <p><strong>Proposed collaborators:</strong> ${esc(row.proposedCollaborators.join(", "))}</p>
  <p><strong>Human decision boundary:</strong> ${esc(row.humanDecisionBoundary)}</p>
  <p><strong>Required future systems:</strong> ${esc(row.requiredFutureSystemsAndTools.join("; "))}</p>
  <p><strong>Catalogued evidence:</strong> ${esc(row.completionEvidenceAsCatalogued.join("; "))}</p>
  <p><strong>Proposed acceptance (not approved):</strong> ${esc(row.proposedEvidenceAcceptance)}</p>
  <p><strong>Contract flags:</strong> ${esc(row.contractFlags.join("; "))}</p>
  <p><strong>Current support:</strong> ${esc(row.currentCapability.catalogueCoverage)}; registered domain execution unavailable; verified domain execution not established.</p></details>`).join("\n");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HRO intent and agent assessment — ${esc(data.assessedOn)}</title><style>
body{font:16px/1.6 system-ui,sans-serif;color:#172c40;background:#f6f8fa;margin:0}
main{max-width:1160px;margin:auto;padding:32px;background:white}nav{display:flex;gap:16px;flex-wrap:wrap;padding:16px;background:#eaf1f7}
h1,h2,h3{line-height:1.25;color:#153d62}h2{margin-top:36px}a{color:#175ca0}code,pre{font-size:13px;overflow-wrap:anywhere}
pre{background:#eef2f6;padding:16px;white-space:pre-wrap}.table{overflow-x:auto}table{border-collapse:collapse;font-size:13px;width:100%}
td,th{border:1px solid #cbd5df;padding:9px;text-align:left;vertical-align:top}th{background:#eaf1f7}
details{border:1px solid #cbd5df;border-radius:6px;padding:12px;margin:8px 0}summary{cursor:pointer;font-weight:600}
.download{display:inline-block;padding:10px 14px;border:1px solid #175ca0;margin:6px;border-radius:5px}.bullet{margin-left:12px}
blockquote{border-left:4px solid #ba8520;padding-left:12px}@media print{nav,#downloads{display:none}main{padding:0}.table{overflow:visible}details{break-inside:avoid}}
</style></head><body><main><nav><a href="#assessment">Executive assessment</a><a href="#tables">Service and role review</a><a href="#capabilities">Capability evidence</a><a href="#definitions">All definitions</a><a href="#downloads">Downloads</a></nav>
<section id="assessment">${markdown(read("README.md"))}</section>
<section id="downloads"><h2>Download machine-readable files</h2><p>Embedded copies work without a server or internet connection.</p>
${download("intent-agent-matrix.json", "application/json")}
${download("intent-agent-matrix.csv", "text/csv")}
${download("gap-register.json", "application/json")}
${download("reconciliation-results.json", "application/json")}</section>
<section id="tables">${markdown(read("review-tables.md"))}</section>
<section id="capabilities">${markdown(read("capability-ledger.md"))}</section>
<section id="definitions"><h2>All 320 canonical definitions</h2><p>319 atomic definitions plus one composite. Expand a row to read the current and proposed contracts separately.</p>${details}</section>
</main></body></html>`;
fs.writeFileSync(path.join(out, "hro-intent-agent-assessment.html"), html);
console.log(`Exported ${out}/hro-intent-agent-assessment.html with ${data.definitions.length} definitions and four embedded downloads.`);
