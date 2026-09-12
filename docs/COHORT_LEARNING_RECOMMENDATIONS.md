# Cohort learning recommendations

The Learning Recommendations screen is an evidence-to-policy review workflow, not an automated optimization loop.

## Evidence contract

- The analysis window is 30, 90, 180, or 365 days by case creation date.
- Eligible outcomes require a completed, non-scenario case and a dated `Gate C Day-1 readiness confirmed by HR` event written by the human readiness gate.
- Any scenario case, or a case with an event marked demo/simulated, is excluded. It is never counted as a success.
- A recommendation requires at least five eligible outcomes from one enabled, current targeted-profile version and a complete historical `processPolicy.learning` record that compiles under `workforce-step-runtime/v1`: joining-date timing, ordered compact sequence or typed steps, the connected manager-led channel, and ownership.
- The evidence snapshot persists the methodology version, window, observed outcome dates, non-PII case references, **cohort-specific** sample/exclusion/missingness counts, mean time to verified readiness, descriptive 95% interval when calculable, and a SHA-256 evidence fingerprint. Counts are never tenant-wide totals.
- Results are descriptive associations, not causal claims. Sparse, stale, incomplete, or simulated evidence returns an explicit insufficient-evidence result; it does not produce a default.

Expert-authored workforce starter templates remain separately labelled guidance. They are not cohort evidence and are not mixed into the analysis.

## Review and publication

Only organization owners and admins can refresh evidence or decide a recommendation. A reviewer may accept the proposed executable learning policy, edit its supported timing, sequence/steps, or ownership before accepting, or reject it with an optional note. The sole learning delivery channel is manager-led. Email, portal, and offer-acceptance anchoring are not selectable because no learning-task executor supports them; the actual candidate portal remains an intake-evidence path.

The authenticated, tenant-scoped API is:

- `GET /api/onboarding/policy-recommendations?windowDays=90` for the review queue and current sparse-evidence status;
- `POST /api/onboarding/policy-recommendations/refresh` to create only new, fingerprinted proposals; and
- `POST /api/onboarding/policy-recommendations/{id}/decision` with the required evidence fingerprint to accept, edit-and-accept, or reject.

Acceptance locks the proposed recommendation and checks its immutable evidence fingerprint plus the target profile version. It compiles the exact edited/proposed value with the workforce-step compiler before publication, and fails closed if any fallback policy-review task would be required. It then creates a new immutable version of the existing targeted profile, copying all checklist overrides and non-learning controls unchanged and replacing only `processPolicy.learning`. This means acceptance cannot disable, weaken, or waive a compliance gate.

The existing case snapshot model means the published profile is selected only when a **future matching case** is created. The runtime compiles the snapshot into accountable, ordered human learning tasks; it enforces task prerequisites and not-before dates and requires completion evidence. Open and completed cases are never modified. A changed target profile creates a version conflict instead of a stale publication.