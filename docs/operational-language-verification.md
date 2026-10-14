# Operational language — development verification

Checked 2026-10-14. This change is presentation-only; no publication was performed.

## Presentation inventory and decisions

| Surface | Application-owned presentation updated or audited |
| --- | --- |
| Control Tower | Dashboard, client dialog, cases, detail headers, submitted-field projections, workstreams, timeline, next actions, Communications, delivery badges, request references, operational preparation, BGV notices, call/reminder previews, agents, Systems, Learning Guide, recommendations, early tenure and offboarding help |
| API / AI | Authorized fixed-journey evidence, natural explanation instructions, execution-confirmation question category, new request/notification templates, email identity labels, operational authorization errors and metric definitions |
| UAT | Admission, policy-quality evaluation, fairness evidence and drift notifications; testing is not certification |
| Employee Vault | Audited; privacy, verification, consent and personal ownership language retained, no relevant artificial-case copy found |
| Cost Explorer | Audited; scenarios, estimates, assumptions and routing maturity remain analytical concepts, not case-execution claims |
| Architecture | Actual served BusinessDeck components updated; manifest required no copy change. Rendered deck and both downloadable formats checked |

Systems explains once that application-managed scenario data is used until connected systems supply confirmed results. It distinguishes configured adapters from connected sources and describes HR, BGV, IT, payroll/benefits, learning and calendar information. Gmail, WhatsApp and monitor health remain based on their existing availability paths, not a blanket “all integrations are missing” state.

Fixed completed/rejected/blocked journey projections are reused, not recreated. Stage and correspondence dates are no longer displayed. The browser found additional fixed-inventory effective/due dates in headers, lists and submitted fields; these are now withheld as unconfirmed in those display projections. Ordinary submitted dates and underlying source records are unchanged. Fixed journeys also take precedence over the legacy generic “held for review” layout.

Prepared correspondence says “Delivery not confirmed”; stored non-delivery states display “Not sent” or “Recorded only — not sent.” Recorded completion is not provider verification. Actual receipts retain their real sent/delivered/failed status. No history body is sanitized.

## Browser observations

One read-only authenticated pass used the visible Demo Reviewer login, without credentials, sends, activation, new cases, access changes or evaluation runs.

- Case list: **390×844 phone, 768×1024 tablet, 1440×900 desktop**.
- Completed S3691: detail at all three sizes; rejected S3693 and blocked S3694: phone and desktop. Overview, Tasks, Activity, Communications and next actions agreed on their outcomes. Completed/rejected requests had no contradictory pending work; blocked requests retained the specific country/entity policy-owner requirement.
- Case correspondence was prepared and delivery-unconfirmed; message histories were empty. No fabricated sent/delivered message was observed.
- No document-wide overflow on tablet/desktop case lists or phone Systems. Phone primary navigation was horizontally clipped; case tabs remained reachable.
- Agents: tablet; Systems: phone and desktop. Systems centralized availability copy appeared and actual channel/monitor statuses remained visible. The standard-provider panel stayed loading during this observation.
- Learning Guide: phone, including actual text download. Coverage showed no mapped runtime scenarios; static mapping did not claim execution.
- Employee Vault: phone public landing. No personal records or consent were changed.
- Cost Explorer: authenticated desktop dashboard and an existing scenario. Loading a saved scenario automatically recalculates the commercial rollup through the existing compute path; source inspection confirms saving is separate. This is financial modeling, not a case run or external HR transaction. No Compute/Save control was clicked.
- Architecture: phone title slide, plus authenticated **200** downloads: PDF **390,177 bytes**, PPTX **6,048,242 bytes**, correct MIME types and valid file signatures.
- Ask AI: permission restriction displayed with no composer. No disclosure fence was bypassed and no live model question was submitted.
- UAT: phone front door and its separate fresh sign-in. Protected UAT pages could not be checked without normal UAT credentials; the ordinary Demo ticket was not treated as admission.

The browser’s date finding was corrected afterward and confirmed by rendered/header/intake/list-date regressions, not a second browser pass. Agents at phone/desktop, authenticated UAT, personal Vault records and a successful live AI answer remain **unverified in a browser**. Existing case-tab 403s and later intermittent resource 502s were observed; they did not prevent the inspected case text from rendering. Development-key and autocomplete warnings are not operational confirmations.

All modified services restarted and served requests. Logs still contain existing background readiness/audit-worker failures, including missing approved lifecycle policies; a running service is not a claim that those integrations or workers are healthy. This wording change does not approve missing policies or suppress their failures.

## Automated checks

- Canonical `pnpm run typecheck`: passed.
- Control Tower rendered/unit suite: includes all 12 families × completed/rejected/blocked, health, overview, tasks, timeline, actions and correspondence; protects identity/permission boundaries, original source text, confirmed dates and unconfirmed delivery.
- UAT suite: current retained history/admission tests replace obsolete imports of retired fixture/progression helpers; the retired features were not restored.
- API suites passed: fixed synthetic journey eligibility/outcomes, read-only explanation evidence collector, case explanation route (including execution-confirmation, citation validation, tenant/permission denial, prompt injection and provider denial), email identity, operational agent descriptions, outcome KPIs, retired UAT actions, operational preparation, channel status, synthetic-offline fences and architecture download routing/failures.
- `operational-requests.test.ts` failed during fixture setup: legacy positive specialist approval identifiers do not satisfy current permission-based lifecycle review. `bgv-notifications.test.ts` had failures and stalled on legacy authority/race fixtures; its attempt was bounded and its two exact temporary workspaces were removed. Production gates were not relaxed. Repair is proposed separately.
- The older `onboarding-demo-browser` workflow had already failed for missing ffmpeg before this pass. It is not evidence that the updated UI passed or failed. The separate browser pass above is the served verification.

## Intentional wording exceptions and safeguards

- “Scenario,” “estimate,” bottleneck simulation and routing implementation maturity remain where they describe financial/modeling analysis, not artificial-case banners.
- UAT/test terminology, security-drill attacks and non-certification boundaries remain meaningful.
- Test documents retain **“Test document — not valid for submission”** and explicit non-genuine identity/bank/tax/employment safeguards. Retired fixture distribution still rejects; it was not reopened.
- User content, historical messages, immutable audit entries, approved/source definitions, reserved IDs, fixtures, structured provenance and delivery enums are not rewritten. Historical downloads may therefore contain their original wording.
- S-prefixed case references and identity/access boundaries remain. A display-only operational request prefix does not change persisted identifiers.
- Offboarding final closure is still unavailable pending approved section 4.6 requirements, not described as blocked only by integrations.

## Downloads and publication

Both current architecture exports were regenerated from the served slide components and placed in content-addressed App Storage objects. Existing authenticated download routes now serve those reviewed objects, failing explicitly if unavailable; no new large binary was added to Git. PPTX text extraction confirmed the changed request-stage/provider-confirmation wording and absence of the old operational-request-simulations phrase.

The Learning Guide download uses the same current catalog/projections as its screen. UAT retained evidence reports preserve their historical metadata rather than being rewritten. No other served changed-source download was found needing regeneration.

All availability observations are **development**, not verification of a published deployment. The app code and download pointer changes require the normal task merge; no production deployment, provider connection or external transaction was performed.
