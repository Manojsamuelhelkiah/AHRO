# Capability evidence ledger

Assessed **2026-10-16**, by inspection of current repository code and retained research. No authenticated tenant inventory, provider credentials, production records, remote probes, model calls or current domain completion receipts were accessed. “Not established” is not the same as “no implementation exists.”

## Layers that must not be conflated

| Layer | Current evidence inspected | What is established | What is not established |
|---|---|---|---|
| Operational definitions | `artifacts/api-server/src/lib/intent-catalog.ts`, `intent-catalog.test.ts` | 319 canonical atomic definitions and one composite; current coverage is catalogued/illustrative; proposed invocation/composition metadata | Integrated/verified completion of any canonical outcome; approved typed outcome schemas |
| Role catalogue | `artifacts/api-server/src/lib/agent-catalogue.ts` | Twelve domain and three supporting roles; reviewed service coordination associations; every role says `operationalCapability: unavailable` | Adapter, principal registration, permission, approved policy or execution support |
| Registered principal invocation | `artifacts/api-server/src/lib/agent-invocation.ts`, `EXECUTABLE_AGENT_TOOL_KEYS`, `evaluateAgentInvocation`, `invokeAgentToolInContext` | Two implemented read tools: `tool.case.read` and `tool.context.read`; owner-initiated, tenant/case scoped, live access checks and protected audit | Domain writes, external tools or provider execution through this invocation path. An inline comment saying “only” metadata read is older than the actual two-tool allowlist |
| Working context | `artifacts/api-server/src/lib/transaction-context/onboarding.ts`, used by invocation | Read projection of existing case context, independently scoped | A new workflow engine, authority from handoff notes, or completion evidence inferred from context |
| Action Center conversation | `artifacts/api-server/src/lib/onboarding/action-conversation-contract.ts`, `action-conversation-agents.ts`, `action-conversations.ts`, `action-conversation-provider.ts` | Human annotations and read-only AI triage; explicit notice that no messages, assignments, escalations or approvals are dispatched; agent selection is descriptive | Invocation of selected principal, newly granted tools, authoritative evidence from annotations, or executed suggestions |
| Legacy reference registry | `artifacts/api-server/src/lib/intent-registry.ts`, `research/intent-agent-coverage.json` | Separate 60 commercial/reference concepts and legacy registry action/evidence declarations | Current canonical support inferred from older simulated/unsupported labels |
| Historical operational personas | `artifacts/api-server/src/lib/onboarding/operational-agents.ts` | Five product-owned simulated persona labels, each explicitly `simulated: true` | Five additional registered agents, live vendors or executors. Similar names do not merge identities |
| Legacy workflow preparation | `artifacts/api-server/src/lib/onboarding/engine.ts`, `connectors.ts` | Case/task orchestration and connector abstractions exist; connector defaults contain simulated vendor labels | Current authorized end-to-end source-system operation for all outcomes or a role adapter inferred from workflow labels |
| Standard provider adapter code | `artifacts/api-server/src/lib/onboarding/standard-provider-adapters.ts` | Oracle HCM and ServiceNow adapter primitives, injected transport, configuration validation and effect-journal-aware dispatch constraints | Active tenant configuration, credentials, successful remote result or general payroll/IAM/LMS execution |
| Authoritative source reading | `artifacts/api-server/src/lib/onboarding/standard-provider-source-read.ts` | Server-side composition for Oracle HCM/ServiceNow source reads; settings/configuration contracts exist | This review did not read secrets, call these providers or verify a tenant's current source connection |
| Early tenure | `artifacts/api-server/src/lib/onboarding/early-tenure.ts` | Dedicated lifecycle preparation, decisions and evidence-fencing implementation | Universal registered-agent support for probation outcomes or current domain execution receipts |
| Frontline release | `artifacts/api-server/src/lib/onboarding/frontline-operations.ts` | Dedicated release controls and evidence dependencies beyond generic learning/readiness | Automatic professional safety release, or a canonical frontline release leaf already approved |
| Controlled transfers | `artifacts/api-server/src/lib/onboarding/workforce-transfer.ts` | Dedicated country/evidence/cutover controls and source-attested paths exist | Generic unrestricted transfer execution by the registered Mobility principal |
| Access/equipment communications | `artifacts/api-server/src/lib/offboarding/exchange-service.ts`, `agentGate` | Narrow current exception lets an active admin-owned principal use its named administrator initiator's scoped read/email rights for this flow; enrollment and recipient/transport checks remain | Provisioning/revocation, asset fulfillment, payroll effects, professional approval, general agent send permission or final exit closure |
| Provider communication | Existing offboarding exchange and onboarding provider routines | Conditional messaging paths can exist separately from domain fulfillment | This review did not send mail/WhatsApp, treat Gmail availability as an HRIS adapter or infer current delivery from a connected integration |
| Independent domain execution | Current catalogue coverage evidence and invocation boundary | **No approved current integrated or verified canonical domain receipt is established in the inspected catalogue** | This is not a claim that no human has ever completed an outcome or that every legacy path is a mock |
| Talent at Risk | Master `retention` outcomes `analyze-retention-signal`, `create-retention-action`; separate active model workstream | Source catalogue already distinguishes signal analysis and human action | Model accuracy, deployment, trained-data suitability or current model integration was not evaluated; no active model implementation is changed |

## Current systems versus required future systems

The matrix's **source contracts** preserve the master source's declared systems/actions/approval labels. Most are generic research templates, not verified adapters. Its **required future systems and proposed evidence acceptance** are review requirements at domain/service level, explicitly marked as unapproved. They do not overwrite the catalogue.

For every definition, the matrix records:

1. The actual catalogue coverage and its actual evidence text.
2. Current role associations, including supporting overlaps and composite propagation.
3. The two registered-agent read tools, with their limits.
4. Required future systems, human boundaries and proposed evidence, without marking them implemented.
5. “Not established” for verified domain execution.

A later capability audit should bind an exact definition revision to the actual source-system object/version, authorized human decision, target receipt, uncertainty reconciliation, and independent verification. A passing unit test, a source adapter, a read-only answer, a synthetic request and a historical simulation are not substitutes.

## Known stale statements, reconciled

- `research/hro-intent-agent-architecture.md` and `research/intent-agent-coverage.json` remain historical 60-reference/commercial assessments. Their two simulated routes and two historically observed custom rows must not become current canonical coverage or tenant counts.
- `research/drafts/hro-master-gap-review.md` describes an earlier 87-service/300-leaf draft. Its suggested atomic `new-hire-setup` conflicts with the now-preserved composite boundary. Its BGV, privacy, statutory-pay, payable-time, grievance and probation gaps are mostly now present; the candidate register states exactly which.
- `research/agent-catalogue-registration-boundaries.md` describes only `tool.case.read`. The current invocation code additionally implements `tool.context.read`; the code allowlist is authoritative for this assessment.
- `action-conversation-agents.ts` still describes selection as metadata-only and its capability copy as case metadata read only. This does not broaden invocation or authorize writes; distinguish its presentation from the actual two-tool allowlist. UI cleanup is outside this assessment.
- Research `accountableAgent`/`agentCapabilities` labels are specialist planning labels, not extra current registered catalogue roles. Their target maturity fields are aspirations, not current evidence.

## Source limitations

The master source registry contains 37 entries with different evidence strengths (fetched, snippet, linked context or other discovery evidence). Saved source files were generally fetched in September 2026; this October review inspects those captures, not newly fetched current law. Family-scope provenance cannot prove every decomposed outcome's exact external label. Government guidance can be jurisdiction-specific (including UK and US public-sector material); vendor documentation is product scope, not law; professional guidance is not a delegated professional decision.

The one affirmative new-outcome proposal, initial performance-improvement-plan establishment, is grounded in the inspected saved CIPD performance-management discussion (`research/sources/master-talent-01.md`, formal-processes paragraph). It has **medium confidence**, because a primary domain owner must still approve the precise record boundary and jurisdiction/policy implications. No generic source-family label is treated as an exact alias.
