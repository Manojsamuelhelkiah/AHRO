# Workflow drafting and bottleneck scenarios

## Plain-language drafts

Open **Settings → Policy Studio → AI Drafter**. Describe a supported targeted onboarding profile, for example: “For contractors in India, retain the baseline checklist and use priority 10.”

Generation is a read-only proposal operation. It does not save a profile, publish a policy, rebase an active case or contact an external system. The response shows the baseline version, proposed effective checklist, rationale and a bounded preview of matching active cases. Matching is not evidence that those cases will be changed.

Review the proposal and acknowledge its limitations before opening the existing profile editor. The handoff starts disabled; saving and any later publication use the existing guarded profile workflow. A changed prompt or another generation invalidates the prior acknowledgement.

Supported output is deliberately limited to the existing matching and checklist-profile capabilities. Unsupported requests are rejected with an explanation. This is not a general agent executor, legal-policy approval tool or permission to introduce new payroll/access actions. AI proposals cannot disable an enabled baseline item; ordinary manual-editor semantics are unchanged.

## Bottleneck simulator

Open **Analytics → Bottleneck Simulator** and choose a cohort.

The measured baseline uses the existing evidence-filtered average onboarding cycle-time metric. Missing observations remain unavailable. Select **Manual Entry** explicitly to use an assumed baseline, including when measured data exists.

For BGV, approvals, documents and provisioning, enter signed delay changes and a critical-path share:

- Positive days add delay; negative days represent an assumed improvement.
- Share is the assumed proportion of that change that affects total elapsed time.
- Blank stages are not modeled. An entered zero is a deliberate zero assumption.

The calculation is:

`scenario mean = max(0, baseline mean + sum(stage delay × critical-path share / 100))`

For example, a 10-day baseline with a +3-day BGV assumption at 100% share produces 13 days; at 50% share it produces 11.5 days.

This is a deterministic what-if calculation, not a calibrated forecast, queueing model or demonstration of causality. Stage changes may overlap in real workflows. The threshold comparison applies to the mean only: it cannot establish the percentage or number of cases that would miss an SLA. A zero floor is disclosed, not represented as proof that instantaneous onboarding is possible.

Changing cohort filters resets scenario inputs. Simulations are temporary and read-only; they do not update cases, recorded KPIs, SLA policies or the separate Cost Explorer.

## Related work

The approved-source HR-policy assistant is a separate feature. Case explanations, profile drafting and policy-source answers have different evidence and authority boundaries and must not be conflated.