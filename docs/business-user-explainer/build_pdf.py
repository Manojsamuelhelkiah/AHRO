"""Build the business-user explainer; no application data or credentials are used."""
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, KeepTogether,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "deliverables" / "Agentic_HRO_Business_User_Explainer.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
pdfmetrics.registerFont(TTFont("Business", str(FONT_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont("BusinessBold", str(FONT_DIR / "DejaVuSans-Bold.ttf")))
pdfmetrics.registerFontFamily("Business", normal="Business", bold="BusinessBold")

NAVY = colors.HexColor("#10243E")
BLUE = colors.HexColor("#1763AB")
INK = colors.HexColor("#26364A")
MUTED = colors.HexColor("#536476")
PALE = colors.HexColor("#EDF4FA")
AMBER = colors.HexColor("#8A5500")
TEAL = colors.HexColor("#126E65")
W, H = A4
CONTENT_W = W - 92
styles = {
    "eyebrow": ParagraphStyle("eyebrow", fontName="BusinessBold", fontSize=9,
        leading=13, textColor=BLUE, spaceAfter=9),
    "title": ParagraphStyle("title", fontName="BusinessBold", fontSize=24,
        leading=30, textColor=NAVY, spaceAfter=12),
    "intro": ParagraphStyle("intro", fontName="Business", fontSize=11.3,
        leading=16.5, textColor=INK, spaceAfter=13),
    "h2": ParagraphStyle("h2", fontName="BusinessBold", fontSize=13,
        leading=18, textColor=NAVY, spaceBefore=12, spaceAfter=5),
    "body": ParagraphStyle("body", fontName="Business", fontSize=10,
        leading=14.5, textColor=INK, spaceAfter=6),
    "small": ParagraphStyle("small", fontName="Business", fontSize=8.7,
        leading=12.5, textColor=MUTED, spaceAfter=5),
    "example": ParagraphStyle("example", fontName="Business", fontSize=9.5,
        leading=14, textColor=INK, spaceAfter=0),
    "cell": ParagraphStyle("cell", fontName="Business", fontSize=9,
        leading=13, textColor=INK),
    "cellhead": ParagraphStyle("cellhead", fontName="BusinessBold", fontSize=9,
        leading=13, textColor=colors.white),
}

story = []


def p(text, style="body"):
    return Paragraph(text, styles[style])


def add(text, style="body"):
    story.append(p(text, style))


def section(title, body, status="Implemented"):
    color = {"Implemented": TEAL, "Configuration required": AMBER, "Roadmap": BLUE}[status]
    story.append(KeepTogether([
        p(title, "h2"),
        p(f'<font color="{color.hexval()}"><b>{status.upper()}</b></font>', "small"),
        p(body),
    ]))


def example(text):
    box = Table([[p("<b>Business example</b><br/>" + text, "example")]],
        colWidths=[CONTENT_W])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PALE),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#C7D8E8")),
        ("LEFTPADDING", (0, 0), (-1, -1), 11),
        ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    story.extend([Spacer(1, 5), box, Spacer(1, 5)])


def page(number, title, intro):
    if story:
        story.append(PageBreak())
    add(f"AGENTIC HRO  /  BUSINESS USER GUIDE  /  {number:02d}", "eyebrow")
    add(title, "title")
    add(intro, "intro")


def table(headers, rows, widths):
    data = [[p(escape(x), "cellhead") for x in headers]]
    data += [[p(x, "cell") for x in row] for row in rows]
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, NAVY),
    ]))
    story.append(t)


page(1, "Security, privacy, trust\nand responsible AI",
    "A practical explanation of the app, its execution safeguards and its remaining roadmap. "
    "<b>AI assists with HR work; an AI recommendation is not permission to act.</b>")
add("Capability review: 8 October 2026. Examples are illustrative, not customer results.", "small")
table(["How to read this guide", "What the label means"], [
    ["<b>Implemented</b>", "A capability exists in the reviewed application. Availability still depends on the user's access and relevant configuration."],
    ["<b>Configuration required</b>", "The control or integration boundary exists, but approved policies, authority, provider setup or operational evidence are prerequisites. This is not a claim that a live service is enabled."],
    ["<b>Roadmap</b>", "Additional capability or assurance work is not present as the complete function described. It is proposed improvement, not a delivery commitment."],
], [150, CONTENT_W - 150])
section("Organization isolation and scoped access",
    "Client records are scoped to the current organization. Named people and registered agents "
    "receive defined permissions through access groups and scopes. Signing in is not permission "
    "to see every client's records or use every tool.")
section("Temporary access and professional authority",
    "Temporary access can expire. Organization ownership or administration does not automatically "
    "grant legal, medical, privacy or payroll specialist authority.")
example("A hiring manager can track onboarding progress without automatically receiving "
    "medical findings. A documentation agent is not allowed to change payroll simply because "
    "it recommends that change.")
add("<b>Assurance boundary:</b> This guide is a capability explainer, not a penetration-test "
    "report, regulatory certification or confirmation of every live tenant's configuration.", "small")

page(2, "Privacy and protected records",
    "The aim is to collect only what is permitted, disclose only what is authorized, "
    "and retain information under reviewed rules.")
section("Sensitive-data policies, retention and holds",
    "Sensitive collection and use require the applicable approved policies. Missing approval "
    "or uncertain classification can block processing. Retention controls and legal holds "
    "govern cleanup; draft policy proposals do not authorize live handling.",
    "Configuration required")
section("Controlled uploads and quarantine",
    "Private file handling and scan gates protect access to sensitive uploads. Quarantined "
    "files cannot simply be opened or approved to finish a checklist. Scan availability "
    "and results depend on the configured scanner. Malware safety is separate from authenticity.")
section("Restricted AI evidence",
    "Domain evidence builders apply authorization and minimization or redaction before model "
    "disclosure. Unclassified text is not automatically safe. Context history is metadata-only: "
    "it does not store prompts, answers, documents or contact details.")
section("Reviewed context-history cleanup",
    "Automatic pruning needs an approved retention rule. Unfinished, recent, oversized or "
    "otherwise unsafe-to-delete chains are preserved. Applicable legal holds can pause "
    "cleanup across a tenant. Protected audit evidence is retained independently.",
    "Configuration required")
example("A privacy reviewer approves a retention rule, but a legal hold is active. "
    "The app preserves the affected history instead of deleting it on age alone. "
    "An old unfinished attempt is not treated as completed just to make cleanup easier.")
add("<b>Roadmap:</b> Broader consolidated compliance evidence packs and obligation-to-control "
    "coverage reporting would make oversight easier. Existing audit and review records "
    "are not a complete certification package.")

page(3, "The agent harness and testing harness",
    "The agent harness controls execution. The testing harness checks whether that behavior "
    "works under the conditions tested. Neither is an extra AI model.")
table(["Implemented execution control", "Meaning for business users"], [
    ["Named agent and tool scope", "The app checks the registered executor and permitted action. Agent identity or permissions supplied in a request are not accepted as authority."],
    ["Live gates and approvals", "Sensitive or consequential actions remain subject to current policy, permission, authority and evidence checks."],
    ["Bounded AI requests", "AI input and output requests have budgets. Mandatory evidence is not silently removed to fit an oversized request."],
    ["Checkpoints and effect records", "Recovery uses recorded work and safe dispatch controls rather than blindly repeating completed external actions."],
    ["Metadata investigation", "Personal history and separately authorized operator history show attempts, steps, filters, correlation links and older pages. History does not authorize a business retry."],
], [155, CONTENT_W - 155])
example("An external operation times out. If repeating it could create a duplicate change "
    "and the outcome cannot be confirmed, the app stops for reconciliation. "
    "A supported idempotent operation may be retried through its existing safeguards.")
section("UAT, controlled demos and regression checks",
    "The UAT Test Center, guided scenarios, controlled demo paths and automated checks "
    "support assurance. Observed evidence, simulations, blocked work and manual steps "
    "must remain distinguishable. A passed test covers the tested behavior, not all possible failures.")
example("A test confirms that an authorized reviewer can perform an action and an "
    "unauthorized reviewer is denied. A simulated payroll exchange does not prove a "
    "real payroll provider was updated.")
add("<b>Roadmap:</b> Extend the harness with systematic answer-quality benchmarks, "
    "fairness scenarios and provider-specific conformance tests before expanding high-risk automation.")

page(4, "Trust and responsible AI",
    "Good answers need relevant evidence. Safe actions need current authority. "
    "Uncertainty should remain visible instead of being converted into apparent success.")
section("Approved-source policy answers",
    "The Policy Assistant uses approved, dated, audience-authorized material. Its constrained "
    "selection validates the allowed extract and exact quotation, rather than accepting "
    "arbitrary invented citations. Insufficient, conflicting or unsafe material can prevent an answer.")
section("Recorded-evidence case explanations",
    "Case explanations describe available recorded evidence, not hidden model reasoning. "
    "Missing facts should be reported as not established. Model output is not proof of "
    "eligibility, authenticity or professional approval.")
section("Approval, readiness and audit controls",
    "Recorded approvals, readiness gates and tamper-evident audit records support traceability. "
    "A checklist score or completed execution attempt does not by itself prove business completion.")
section("Independent audit assurance",
    "The protected-audit framework has provider-verification and launch-drill gates. "
    "Independent assurance requires the client's approved provider, current verified "
    "checkpoints and successful drills. A local hash chain alone is not independent proof.",
    "Configuration required")
example("For 'Why is onboarding blocked?', the app should identify recorded missing "
    "evidence or approval. For a leave-policy question, it should cite applicable approved "
    "material or explain that an answer cannot be established; a confident guess is not sufficient.")
add("<b>Roadmap - answer quality:</b> Business-approved benchmark questions, broader "
    "claim-to-source validation across answer types, systematic model-change evaluations "
    "and more deterministic eligibility/deadline rules.")
add("<b>Roadmap - fairness:</b> A dedicated fairness evaluation programme and AI-decision "
    "appeal process. Use reviewed, job-relevant criteria, synthetic paired tests and "
    "lawfully governed outcome analysis. Human review alone does not eliminate bias.")

page(5, "Document authenticity and Employee Vault",
    "A readable, malware-safe file can still be forged. Authenticity needs trustworthy "
    "source evidence tied to the correct person and exact document version.")
section("Independent employee ownership and consent",
    "Employee Vault is a separate employee-owned application. Registration does not grant "
    "employer membership or reviewer authority. Employer sharing requires explicit consent, "
    "scope, current requirements, freshness and case binding.")
section("Signed, version-bound verification controls",
    "The Vault checks signed source results against approved issuer configuration and binds "
    "results to document revisions and content hashes. A changed, expired or no-longer-valid "
    "binding is not treated as current verification. This framework is not proof that "
    "every document type has a connected verification service.")
section("Live issuer and verification connections",
    "Real verification requires an approved issuer or provider, supported check types and "
    "jurisdictions, and authenticated source results. No unspecified commercial provider "
    "should be represented as a working integration.",
    "Configuration required")
example("An employee uploads a degree certificate. Extracting the name and degree is "
    "not verification. An approved source must confirm the relevant record and person match; "
    "the result must remain bound to the submitted document version.")
example("An employer requires identity, education and employment checks. A clear identity "
    "result alone does not mean full background verification. The employee can withdraw "
    "future sharing authority, but an earlier lawful disclosure is not retroactively undone.")
section("Broader authenticity coverage",
    "Add and validate selected live issuer/provider adapters, strengthen identity matching "
    "where legally appropriate, and extend revocation/freshness checks for the chosen sources. "
    "Source-verified, unavailable, uncertain and adverse results must remain distinct.",
    "Roadmap")

page(6, "Business features and the improvement roadmap",
    "Current work management is separate from the additional assurance work proposed below. "
    "Roadmap items are not described as available features.")
table(["Implemented business area", "Illustrative use"], [
    ["Cases, approvals and Action Center", "Assign an unresolved task to a named owner and track review, evidence and follow-up."],
    ["Onboarding and workforce operations", "Coordinate documents, Day-1 logistics, early-tenure checks, frontline requirements and transfer cutover sign-offs."],
    ["Policies, systems and communications", "Review policy revisions; monitor configured connectors and communication channels. A connector's presence does not establish live provider readiness."],
    ["Analytics and Cost-Benefit Explorer", "Review bottlenecks and compare costs or scenarios using visible assumptions. Estimates are not proven savings or causal outcome forecasts."],
], [160, CONTENT_W - 160])
add("Priority roadmap - additional assurance", "h2")
table(["Area", "Additional work / roadmap", "Business outcome sought"], [
    ["Compliance", "Consolidated obligation-to-control coverage, evidence packs and periodic independent assessment.", "Show which requirements are satisfied, by whom, and with what evidence."],
    ["Authenticity", "Selected live verification adapters and broader source-backed check coverage.", "Distinguish a genuine source result from a plausible uploaded file."],
    ["Answer quality", "Systematic business benchmarks, expanded claim checks and deterministic rules.", "Measure correctness and stop unsupported answers."],
    ["Fairness", "Governed paired tests, lawful disparity analysis and an independent appeal process.", "Detect unequal treatment and provide meaningful review."],
], [80, 255, CONTENT_W - 335])
add("Where users find the controls", "h2")
add("<b>Control Tower:</b> Cases, Approvals, Action Center, Policy Assistant, policy library, "
    "Audit, Systems and UAT Test Center. <b>Settings:</b> access governance, privacy policies, "
    "unified context history and reviewed retention. <b>Separate apps:</b> Employee Vault "
    "and the Cost-Benefit Explorer. Visibility is permission-dependent.", "small")
add("<b>Bottom line:</b> Controls require approved configuration, connected sources, ongoing "
    "tests and independent review. They do not guarantee compliance, universal authenticity, "
    "correct AI answers or bias-free decisions.", "small")


def decorate(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#CFDCE8"))
    canvas.setLineWidth(0.5)
    canvas.line(46, 38, W - 46, 38)
    canvas.setFont("Business", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(46, 24, "Agentic HRO | Business-user explainer | 08 Oct 2026")
    canvas.drawRightString(W - 46, 24, f"{doc.page}")
    canvas.restoreState()


doc = SimpleDocTemplate(str(OUT), pagesize=A4, leftMargin=46, rightMargin=46,
    topMargin=42, bottomMargin=53, title="Agentic HRO - Final Business User Explainer",
    author="Agentic HRO", subject="Implemented controls, configuration prerequisites and roadmap",
    pageCompression=1)
doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
print(OUT.relative_to(ROOT))
