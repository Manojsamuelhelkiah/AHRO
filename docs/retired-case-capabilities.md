# Case-test capability retirement

## Product boundary

Fictional case creation, catalog launch, seeding, reset, response progression,
fixture distribution/execution and model evaluation are permanently retired.
This is not a deletion or a relabeling of stored records.

Authenticated compatibility endpoints return `410` with
`CASE_TEST_CAPABILITY_RETIRED`, before parsing input, allocating a record,
claiming budget, issuing credentials or invoking a provider. UAT endpoints
still require fresh separate admission and verified workspace scope first.
Shared Demo identities cannot fall through to ordinary intake.

## Inventory and enforcement

| Entry point | Retirement boundary | Retained read surface |
| --- | --- | --- |
| `/onboarding/scenarios`, scenario launch | HTTP tombstone before monolithic routes | Restricted case history |
| `/onboarding/synthetic-reset` | HTTP tombstone and service denial; no cleanup | Stored historical receipts remain protected |
| `/onboarding/demo/full-coverage`, seed CLI and login bootstrap | HTTP/service/CLI denial; login does not seed | Existing scoped read grants only |
| Case simulation mutations and inbound progression | HTTP/service denial; reply route discovery empty | Authorized historical case events and communications |
| `/onboarding/uat/runs`, actions and fixture packs | HTTP/service denial, including direct fixture generation | Separately admitted run history and redacted reports |
| Fairness actions | HTTP/service denial before reviews or model spending | Existing authorized evidence report |
| Policy benchmarks, answer-key review and drift configuration | HTTP/service denial | Restricted previous evaluation evidence |
| Scheduled policy drift tick | Inert before DB/provider access | Existing reservations/results are not rewritten |
| Vendor email injection | HTTP/service denial | Genuine verified provider/mailbox callbacks remain |
| Historical case mutations and approvals | Verified tenant lookup, independent run ledger, provenance and controller fences | Current scoped evidence read permissions still required |
| Candidate uploads/portal issuance | Historical mutation and dispatch denial | Existing expiring, scoped evidence access is unchanged |

Historical test records are separate from the operational Cases queue, never
eligible for live outcome metrics, and never a basis for approval authority,
readiness or external work. Provider-effect and audit evidence remains intact.
Retirement does not cancel privacy retention policies or legal holds.
Pending retired progression/evaluation work is not completed or assigned a
fabricated outcome.

Ordinary authenticated intake, approved policies, Employee Vault personal
ownership, genuine callback receipts, explicit operational channel checks,
independent release/security checks and commercial what-if modeling remain.
Simulation-only connectors still do not claim genuine external execution.
No changes authorize shared demo accounts for live workflows.

The separately confirmed developer-only offline inventory extension permits
five complementary fictional slots per current family (ten curated slots per
family including the original five). It is additive, permanently blocked and
read-only; older history remains. It restores no creation, reset, progression,
execution, authority or operational-metric eligibility.

## Allowed retained identifiers and text

This is an explicit category-based allowlist, not an assertion that every
internal text match has disappeared:

- Immutable migrations and stored enum values, including `synthetic_provenance`,
  `onboarding-demo-fictional`, `synthetic-reset`, `demo-full-coverage`,
  `demo-controller-fictional`.
- Durable notes/controller markers, reserved `UAT-` scenario prefixes, UAT
  ownership ledgers, historical run/receipt keys, and the
  `synthetic-demo-bootstrap` authority source used by revocation checks.
- Legacy API operation/type names and npm CLI names as deprecated,
  non-executable compatibility tombstones.
- Internal offline, isolation, authority and retention predicates. These
  must not be renamed or removed to pass a text audit.
- Stored historical audit, provider, source, email and evaluation quotations,
  disclosed only through their existing authorization and privacy boundaries.
- Developer-only regression inputs and comparison routines, without product
  launchers, seeders, provider dispatch or authority creation.
- Explicit commercial assumption scenarios and separately authorized,
  delivery-denied security or operational transport checks.

The product learning catalog is distinct from the retained developer fixture
catalog. The documentation generator and API share the current-operation
catalog. Source requirement quotations remain labeled as historical baseline
evidence; source mapping alone never establishes availability or execution.

## Distributed copies

`build_pdf.py` regenerates the assurance HTML, JSON and PDFs and their public
copies; `verify_pdf.py` checks control/metric concordance and absence of stories.
`generate-uat-learning-deliverables.mjs` regenerates HTML, Word, feature JSON and
traceability CSV from the current-operation catalog. The component-inventory
workbook and Markdown retain historical protection requirements, not an
optional demo-execution feature.

The architecture deck retains controls, provider limitations and commercial
assumptions without offering case-test tools. Build outputs must be regenerated
before release; old distributions must not be copied back into public assets.
