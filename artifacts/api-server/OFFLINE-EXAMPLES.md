# Controlled Demo offline inventory

The approved exception adds **60 new rows**, five per current Control Tower
family, to the existing **Demo Organization** only. It does not replace earlier
examples, modify evidence, grant authority, or restore retired product controls.

From `artifacts/api-server`, run only when explicitly authorized:

```sh
NODE_ENV=development node run-offline-examples.mjs add-60-offline-examples-to-demo
```

The command verifies the existing tenant ID, slug and name. It never bootstraps
a tenant. Fixed new slot identities and a transaction lock make retries and
concurrent attempts converge on the same inventory; conflicting stored data
stops the operation rather than repairing or replacing it.

All offline fences are inserted with each parent before it becomes visible.
No approval, communication, event, logistics, external-operation or completed
evidence rows are provisioned. Details are pending review, not execution plans.

Active, registered Demo profiles receive exact case-scoped read grants for
fictional offline examples (including retained older examples). These use the
ordinary access evaluator and cannot override denies or reactivate revoked
grants. They grant no sensitive-identity permission, editing, tool use or
professional authority. Real-person/hybrid contacts remain excluded.

The count-only result also verifies worker, provider and decision-authority
denials and preservation of existing cases. This command has no HTTP route,
Settings button, startup hook or published-environment mode. Its development
result says nothing about the published database.

## Ten-scenario coverage extension

The separate extension adds **exactly 60 complementary slots** (five per family)
to the original 60 curated slots, for **ten per family**. Older historical cases
remain; ten is a coverage target, not a list cap. Original identities and values
are unchanged. The original command still provisions only the original 60 slots.
The extension fails closed unless all original slots already exist unchanged.
If the authorized development environment is missing that baseline, provision it
with the original command before running the separately confirmed extension:

```sh
NODE_ENV=development node run-offline-examples.mjs extend-demo-to-ten-offline-scenarios-per-family
```

The extension shares the original inventory/read-grant transaction lock. It
rejects duplicate, cross-tenant or changed curated identities without repairing
records. Request attributes use existing template columns, fictional references
and unverified proposed dates. Missing-reference scenarios deliberately retain
blank fields, not fabricated evidence. Unsupported dependencies appear as
unresolved review questions in the scenario summary, not new execution fields.
Offboarding remains preparation only, with final closure unavailable.

This remains a developer-only operation: no HTTP, startup, public controls or
published-mode bypass. Published population requires separate operational
approval and an approved provisioning path; development counts do not prove it.

### Development verification — 2026-10-13

The verified development Demo workspace initially contained 30 retained cases
and none of the original curated slots. The unchanged original command added
the missing 60-slot baseline; the separate extension then added exactly 60 new
complementary slots. Its rerun created zero cases and zero grants.

| Family | Curated cases | Complementary additions |
| --- | ---: | ---: |
| Onboarding | 10 | 5 |
| Employee Changes | 10 | 5 |
| Payroll | 10 | 5 |
| Benefits | 10 | 5 |
| Leave | 10 | 5 |
| Compliance | 10 | 5 |
| Offboarding | 10 | 5 |
| HR Helpdesk | 10 | 5 |
| IT Access | 10 | 5 |
| Learning | 10 | 5 |
| Mobility | 10 | 5 |
| Documents | 10 | 5 |
| **Total** | **120** | **60** |

All 30 older cases remain, giving 150 stored Demo cases. Ordinary Demo Reviewer
access showed 132: 120 curated plus 12 canonical legacy examples. The other 18
retained records kept their existing restrictions; no additional access was
granted to expose them. Provider, worker and authority denial probes passed for
all 120 curated cases. Signed-in case lists/details were checked at phone,
tablet and desktop sizes. **Published population was not modified or verified.**
