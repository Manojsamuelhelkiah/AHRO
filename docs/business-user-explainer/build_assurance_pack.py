"""Render the shared assurance content as PDFs, JSON and a standalone HTML reader."""
from dataclasses import asdict
from html import escape
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether, Table, TableStyle,
)

from assurance_content import (
    REVIEW_DATE, SCOPE, STATUS, SOURCE, GROUPS, METRICS, ROADMAP, DEPLOYMENT,
    BUSINESS_PAGES, TECH_PAGES,
)
from control_use_cases import CONTROL_USE_CASES

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables"
OUT.mkdir(parents=True, exist_ok=True)
FILES = {
    "business": "Agentic_HRO_Business_User_Explainer.pdf",
    "technical": "Agentic_HRO_Security_Leadership_Brief.pdf",
    "inventory": "Agentic_HRO_Control_and_Evidence_Register.pdf",
    "html": "Security_Privacy_Assurance.html",
    "json": "Agentic_HRO_Control_Inventory.json",
}
RISKS = {
    "SEC": "Unauthorized record access, privilege escalation or unverified professional authority.",
    "COM": "Forged, misrouted, duplicated or runaway external communication.",
    "PRI": "Unauthorized sensitive disclosure, excessive retention or unsafe deletion.",
    "DOC": "Unsafe, forged, stale or unconsented document reuse.",
    "AI": "Unsupported, manipulated or harmful AI-supported answers and actions.",
    "RUN": "Cross-scope execution, stale authority or duplicated/ambiguous remote effects.",
    "AUD": "Undetected tampering, unready regulated launch or silent loss of safety services.",
    "TST": "Mistaking limited test, synthetic or demo evidence for live assurance.",
}
FONT = Path("/usr/share/fonts/truetype/dejavu")
pdfmetrics.registerFont(TTFont("Assurance", str(FONT / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("AssuranceBold", str(FONT / "DejaVuSans-Bold.ttf")))
pdfmetrics.registerFontFamily("Assurance", normal="Assurance", bold="AssuranceBold")
NAVY = colors.HexColor("#10243E")
BLUE = colors.HexColor("#1763AB")
INK = colors.HexColor("#26364A")
MUTED = colors.HexColor("#536476")
PALE = colors.HexColor("#EDF4FA")
W, H = A4
WIDTH = W - 92


def validate_sources():
    ids = [row.id for _, _, rows in GROUPS for row in rows]
    assert len(ids) == len(set(ids)), "Duplicate control ID"
    assert len(ids) == 50 and set(ids) == set(CONTROL_USE_CASES), "Use cases must cover exactly all 50 controls"
    for key, path in SOURCE.items():
        assert (ROOT / path).is_file(), f"Missing evidence pointer: {key}: {path}"
    for _, _, rows in GROUPS:
        for row in rows:
            assert row.status in STATUS
            assert all(key in SOURCE for key in row.sources)
            assert 10 <= len(row.business_use_case.split()) <= 60, f"Missing or oversized use case: {row.id}"
    assert len(BUSINESS_PAGES) == 8 and len(TECH_PAGES) == 2


class Document:
    def __init__(self, kind):
        self.kind = kind
        self.story = []
        compact = kind in ("technical", "inventory")
        size = 9.6 if compact else 10.5
        leading = 13.7 if compact else 15.5
        self.styles = {
            "title": ParagraphStyle("title", fontName="AssuranceBold", fontSize=22.5,
                leading=28, textColor=NAVY, spaceAfter=11),
            "eyebrow": ParagraphStyle("eyebrow", fontName="AssuranceBold", fontSize=8.4,
                leading=12, textColor=BLUE, spaceAfter=9),
            "intro": ParagraphStyle("intro", fontName="Assurance", fontSize=10.5,
                leading=15, textColor=INK, spaceAfter=12),
            "h2": ParagraphStyle("h2", fontName="AssuranceBold", fontSize=11.6,
                leading=16, textColor=NAVY, spaceBefore=10, spaceAfter=5, keepWithNext=True),
            "body": ParagraphStyle("body", fontName="Assurance", fontSize=size,
                leading=leading, textColor=INK, spaceAfter=6),
            "small": ParagraphStyle("small", fontName="Assurance", fontSize=8.3,
                leading=11.7, textColor=MUTED, spaceAfter=5),
            "ref": ParagraphStyle("ref", fontName="Assurance", fontSize=7.7,
                leading=10.2, textColor=MUTED, wordWrap="CJK", spaceAfter=5),
        }

    def p(self, text, style="body"):
        return Paragraph(text, self.styles[style])

    def add(self, text, style="body"):
        self.story.append(self.p(text, style))

    def page(self, number, title, intro):
        if self.story:
            self.story.append(PageBreak())
        self.add(f"AGENTIC HRO / {self.kind.upper()} / {number:02d} / {REVIEW_DATE}", "eyebrow")
        self.add(escape(title), "title")
        self.add(escape(intro), "intro")

    def box(self, text):
        table = Table([[self.p(text)]], colWidths=[WIDTH])
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, -1), PALE),
            ("LEFTPADDING", (0, 0), (-1, -1), 11),
            ("RIGHTPADDING", (0, 0), (-1, -1), 11),
            ("TOPPADDING", (0, 0), (-1, -1), 9),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ]))
        self.story.extend([Spacer(1, 8), table, Spacer(1, 8)])

    def save(self):
        label = {
            "business": "Business-user explainer",
            "technical": "Security-leadership brief",
            "inventory": "Control and evidence register",
        }[self.kind]

        def footer(canvas, doc):
            canvas.saveState()
            canvas.setStrokeColor(colors.HexColor("#CFDCE8"))
            canvas.line(46, 39, W - 46, 39)
            canvas.setFillColor(MUTED)
            canvas.setFont("Assurance", 7.7)
            canvas.drawString(46, 25, f"Agentic HRO | {label} | 08 Oct 2026")
            canvas.drawRightString(W - 46, 25, str(doc.page))
            canvas.restoreState()

        document = SimpleDocTemplate(
            str(OUT / FILES[self.kind]), pagesize=A4, leftMargin=46, rightMargin=46,
            topMargin=40, bottomMargin=53, title=f"Agentic HRO — {label}",
            author="Agentic HRO", subject="Controls, evidence, measurement limits and roadmap",
            pageCompression=1,
        )
        document.build(self.story, onFirstPage=footer, onLaterPages=footer)


def sources_text(keys):
    return "; ".join(SOURCE[key] for key in dict.fromkeys(keys))


def test_pointers(keys):
    paths = []
    for key in keys:
        path = Path(SOURCE[key])
        test = path.with_name(path.stem + ".test.ts")
        if (ROOT / test).is_file() and str(test) not in paths:
            paths.append(str(test))
    return paths


def build_business():
    doc = Document("business")
    for number, (title, intro, sections, example, refs) in enumerate(BUSINESS_PAGES, 1):
        doc.page(number, title, intro)
        for heading, text in sections:
            doc.add(escape(heading), "h2")
            doc.add(escape(text))
        doc.box("<b>Business example</b><br/>" + escape(example))
        doc.add(escape(refs), "small")
    doc.save()


def build_technical():
    doc = Document("technical")
    for number, (title, intro, sections) in enumerate(TECH_PAGES, 1):
        doc.page(number, title, intro)
        for heading, text in sections:
            doc.add(escape(heading), "h2")
            doc.add(escape(text))
        if number == 1:
            doc.add("Status: implemented control ≠ configured service ≠ measured assurance. "
                "The companion register separates all three from roadmap and unverified deployment facts.", "small")
        else:
            doc.add("Evidence scope: source/test pointers and defined metrics—not live values, "
                "a fresh test run or an independent certification. Detailed limitations: companion control register.", "small")
    doc.save()


def build_inventory():
    doc = Document("inventory")
    count = sum(len(rows) for _, _, rows in GROUPS)
    doc.page(1, "Control and evidence register", SCOPE)
    doc.box(f"<b>{count} reviewed controls · 8 control families · 12 metric/evidence definitions</b>"
        "<br/>Plus 5 roadmap areas and 6 deployment-evidence categories.")
    for label, definition in STATUS.items():
        doc.add(escape(label), "h2")
        doc.add(escape(definition))
    doc.add("Review method and limits", "h2")
    doc.add("Reconciled documented controls with current source boundaries, the communications "
        "guardrail catalogue, the analytics definitions and expiry-notice implementation. "
        "Source pointers were checked for existence. Test pointers identify nearby automated checks, "
        "not successful execution or complete coverage. No tenant records, credentials, live metric "
        "values or provider configuration were collected. This is comprehensive across the listed "
        "reviewed control families, not a guarantee that no undiscovered control or gap exists.")
    doc.add("Accountability", "h2")
    doc.add("Reviewer roles below are suggested evidence owners, not assigned people or certified "
        "accountability. Obtain dated tenant-specific policy, configuration, test and provider evidence "
        "before claiming operational assurance.")
    doc.add("Business use cases are fictional illustrations of when each control matters, "
        "not records of executed checks, measured effectiveness or certification.", "small")
    doc.story.append(PageBreak())
    for title, owner, rows in GROUPS:
        doc.add(escape(title), "h2")
        doc.add("Suggested evidence reviewer: " + escape(owner), "small")
        for row in rows:
            tests = test_pointers(row.sources)
            parts = [
                doc.p(f"<b>{row.id} · {escape(row.name)}</b>"),
                doc.p("<b>Status:</b> " + escape(row.status), "small"),
                doc.p("<b>Risk addressed:</b> " + escape(RISKS[row.id.split("-")[0]]), "small"),
                doc.p("<b>Control:</b> " + escape(row.mechanism)),
                doc.p("<b>Business use case:</b> " + escape(row.business_use_case)),
                doc.p("<b>Safe behavior:</b> " + escape(row.safe_behavior)),
                doc.p("<b>Limit / residual risk:</b> " + escape(row.limitation)),
                doc.p("<b>Source:</b> " + escape(sources_text(row.sources)), "ref"),
            ]
            if tests:
                parts.append(doc.p("<b>Nearby test pointers, not run:</b> " + escape("; ".join(tests)), "ref"))
            parts.append(Spacer(1, 7))
            doc.story.append(KeepTogether(parts))
    doc.story.append(PageBreak())
    doc.add("Metrics and evidence definitions", "title")
    doc.add("No live metric values are published in this register. Interpret each measurement "
        "using its actual source, denominator, provenance and limits.", "intro")
    for id, title, status, definition, limit, *keys in METRICS:
        doc.story.append(KeepTogether([
            doc.p(f"<b>{id} · {escape(title)}</b>"),
            doc.p("<b>Measurement status:</b> " + escape(status), "small"),
            doc.p("<b>Definition / denominator:</b> " + escape(definition)),
            doc.p("<b>Limitation:</b> " + escape(limit)),
            doc.p("<b>Source or extension boundary:</b> " + escape(sources_text(keys)), "ref"),
            Spacer(1, 8),
        ]))
    doc.story.append(PageBreak())
    doc.add("Roadmap — additional assurance", "title")
    doc.add("These improvements are not described as completed current assurance. No rollout "
        "date, legal certification or provider coverage is promised.", "intro")
    for id, title, scope, caveat, owner in ROADMAP:
        doc.add(f"{id} · {escape(title)}", "h2")
        doc.add("<b>Status: Roadmap.</b> " + escape(scope))
        doc.add(escape(caveat))
        doc.add("Suggested reviewer: " + escape(owner), "small")
    doc.story.append(PageBreak())
    doc.add("Deployment evidence to obtain", "title")
    doc.add("Not verified in this review. These are evidence requirements, not assertions that "
        "the services lack the capability.", "intro")
    for id, title, evidence in DEPLOYMENT:
        doc.add(f"{id} · {escape(title)}", "h2")
        doc.add(escape(evidence))
    doc.box("<b>Acceptance principle</b><br/>Control presence, approved configuration, "
        "verified operational evidence and measured results are different claims. "
        "Record unresolved items instead of inferring assurance.")
    doc.save()


def inventory_data():
    return {
        "review_date": REVIEW_DATE, "scope": SCOPE, "status_definitions": STATUS,
        "live_values_collected": False, "tests_executed_for_this_pack": False,
        "groups": [
            {"title": title, "suggested_reviewer": owner,
             "controls": [
                 {**asdict(row), "source_paths": [SOURCE[k] for k in row.sources],
                  "risk_addressed": RISKS[row.id.split("-")[0]],
                  "published_effectiveness_rate": "Not asserted; see the metric register for defined available evidence and roadmap measurements.",
                  "nearby_test_paths_not_run": test_pointers(row.sources)}
                 for row in rows]}
            for title, owner, rows in GROUPS
        ],
        "metrics": [
            {"id": id, "title": title, "status": status, "definition": definition,
             "limitation": limit, "source_paths": [SOURCE[key] for key in keys]}
            for id, title, status, definition, limit, *keys in METRICS
        ],
        "roadmap": [
            {"id": id, "title": title, "scope": scope, "limitation": caveat, "suggested_reviewer": owner}
            for id, title, scope, caveat, owner in ROADMAP
        ],
        "deployment_evidence_not_verified": [
            {"id": id, "title": title, "required_evidence": text} for id, title, text in DEPLOYMENT
        ],
    }


def build_html():
    parts = ["""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agentic HRO — Security, privacy and AI assurance</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f2f5f9;color:#26364a;font:16px/1.65 system-ui,sans-serif}
main{max-width:1040px;margin:auto;padding:28px 22px 60px}h1,h2,h3{color:#10243e;line-height:1.25}
h1{font-size:clamp(28px,5vw,40px)}h2{font-size:26px}h3{font-size:19px}a{color:#1763ab;overflow-wrap:anywhere}
nav{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0}nav a,.pdf{border:1px solid #c7d8e8;padding:8px 13px;border-radius:6px;text-decoration:none;background:white}
section{background:white;border:1px solid #dce5ef;border-radius:9px;padding:24px;margin:24px 0;scroll-margin-top:12px}
.example,.notice{padding:14px 18px;background:#edf4fa;border-left:3px solid #1763ab;margin:16px 0}
.muted,.refs{color:#536476;font-size:14px}.refs{overflow-wrap:anywhere}details{padding:12px 0;border-bottom:1px solid #dce5ef}
summary{cursor:pointer;font-weight:650;color:#10243e}summary:focus-visible,a:focus-visible{outline:3px solid #1763ab;outline-offset:4px}
.status{font-weight:650}article{margin:22px 0}.divider{margin:32px 0;border-top:1px solid #dce5ef}
@media(max-width:600px){main{padding:16px 12px 40px}section{padding:18px 15px}nav a{flex:1 1 140px}}
@media print{body{background:white}nav,.pdf{display:none}section{border:0;margin:0;page-break-before:always}details{break-inside:avoid}}
</style></head><body><main>
<p class="muted">AGENTIC HRO · REVIEWED 08 OCTOBER 2026</p>
<h1>Security, privacy and responsible-AI assurance</h1>
<p>Read the business guide, two-page security-leadership brief and shared control register here—no PDF download is required.</p>
<div class="notice"><b>Evidence boundary:</b> This is a reviewed code-and-content inventory, not a production audit, fresh test result or certification. No live tenant values are published.</div>
<nav aria-label="Document sections"><a href="#business">Business guide</a><a href="#technical">Security-leadership brief</a>
<a href="#inventory">Control register</a><a href="#metrics">Metrics</a><a href="#roadmap">Roadmap &amp; deployment evidence</a></nav>"""]
    for kind, pages in (("business", BUSINESS_PAGES), ("technical", TECH_PAGES)):
        heading = "Business-user guide" if kind == "business" else "Security-leadership brief"
        parts += [f'<section id="{kind}"><h2>{heading}</h2>',
                  f'<p><a class="pdf" href="{FILES[kind]}">Open this PDF in your browser</a></p>']
        for i, page in enumerate(pages, 1):
            title, intro, sections = page[:3]
            parts.append(f'<article><h3>{i}. {escape(title)}</h3><p>{escape(intro)}</p>')
            for label, text in sections:
                parts.append(f'<p><b>{escape(label)}</b><br>{escape(text)}</p>')
            if kind == "business":
                parts.append(f'<div class="example"><b>Business example</b><br>{escape(page[3])}</div>')
                parts.append(f'<p class="refs">{escape(page[4])}</p>')
            parts.append("</article>")
        parts.append("</section>")
    parts.append(f'<section id="inventory"><h2>Shared control and evidence register</h2>'
        f'<p><a class="pdf" href="{FILES["inventory"]}">Open the full register PDF</a></p>'
        f'<p>{escape(SCOPE)}</p>')
    for label, definition in STATUS.items():
        parts.append(f'<p><b>{escape(label)}:</b> {escape(definition)}</p>')
    parts.append("<p class='muted'>Suggested reviewer roles are not assigned accountability. "
        "Source/test pointers are evidence locations, not a statement that tests passed.</p>")
    parts.append("<p class='muted'>Each business use case is a fictional illustration, "
        "not evidence of an executed check, measured effectiveness or certification.</p>")
    for title, owner, rows in GROUPS:
        parts.append(f'<h3>{escape(title)}</h3><p class="muted">Suggested reviewer: {escape(owner)}</p>')
        for row in rows:
            parts.append(f'<details><summary>{row.id} · {escape(row.name)} — {escape(row.status)}</summary>'
                f'<p><b>Control:</b> {escape(row.mechanism)}</p>'
                f'<div class="example"><b>Business use case:</b><br>{escape(row.business_use_case)}</div>'
                f'<p><b>Risk addressed:</b> {escape(RISKS[row.id.split("-")[0]])}</p>'
                f'<p><b>Safe behavior:</b> {escape(row.safe_behavior)}</p>'
                f'<p><b>Limitation:</b> {escape(row.limitation)}</p>'
                f'<p class="refs"><b>Source:</b> {escape(sources_text(row.sources))}</p>')
            tests = test_pointers(row.sources)
            if tests:
                parts.append(f'<p class="refs"><b>Nearby tests, not run:</b> {escape("; ".join(tests))}</p>')
            parts.append("</details>")
    parts.append('</section><section id="metrics"><h2>Metrics and evidence definitions</h2>'
        '<p>No live numeric values are claimed. Definitions and limitations are shared by both guides.</p>')
    for id, title, status, definition, limit, *keys in METRICS:
        parts.append(f'<article><h3>{id} · {escape(title)}</h3>'
            f'<p class="status">{escape(status)}</p><p>{escape(definition)}</p>'
            f'<p><b>Limitation:</b> {escape(limit)}</p></article>')
    parts.append('</section><section id="roadmap"><h2>Roadmap — additional assurance</h2>')
    for id, title, scope, caveat, owner in ROADMAP:
        parts.append(f'<article><h3>{id} · {escape(title)}</h3><p><b>Roadmap:</b> {escape(scope)}</p>'
            f'<p>{escape(caveat)}</p><p class="muted">Suggested reviewer: {escape(owner)}</p></article>')
    parts.append('<div class="divider"></div><h2>Deployment evidence not verified</h2>'
        '<p>These need separate evidence; they are not assertions that the capabilities are absent.</p>')
    for id, title, text in DEPLOYMENT:
        parts.append(f'<p><b>{id} · {escape(title)}</b><br>{escape(text)}</p>')
    parts.append("</section></main></body></html>")
    (OUT / FILES["html"]).write_text("\n".join(parts), encoding="utf-8")


def main():
    validate_sources()
    build_business()
    build_technical()
    build_inventory()
    (OUT / FILES["json"]).write_text(json.dumps(inventory_data(), indent=2), encoding="utf-8")
    build_html()
    public = ROOT / "artifacts" / "onboarding-agent" / "public"
    for kind in ("business", "technical", "inventory", "html"):
        (public / FILES[kind]).write_bytes((OUT / FILES[kind]).read_bytes())
    for filename in FILES.values():
        print(f"deliverables/{filename}")


if __name__ == "__main__":
    main()
