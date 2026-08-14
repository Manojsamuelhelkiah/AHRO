# HRO Platform — Complete Component Inventory for Effort Estimation

**Purpose:** A build-scope inventory of everything in this application, to price a re-build as a real product on another platform (e.g. Azure). Organized by what a delivery team would actually have to build.

**Date:** August 14, 2026

---

## 1. Applications (user-facing)

### 1.1 Onboarding Agent Control Tower (main web app)
The HR-facing operations console for AI-driven employee onboarding.

| Page / Surface | What it does |
|---|---|
| Login / Auth shell | Branded sign-in (Clerk-hosted identity), demo-login flow |
| Control Tower Dashboard | Live operational overview: case pipeline, approvals, system health |
| Cases list | Filterable case pipeline with status, owner (AI vs human), New Case form |
| Case Details workspace | Sticky header + health strip; tabs: Overview, Tasks, Documents, Activity, Communications, Audit; approvals rail; Take Action menu (incl. voice call) |
| HRO Intelligence (Analytics) | Autonomy rate, review drivers, Day-1 risk, policy-exception analysis, AI-written narrative summary |
| Approvals inbox | Pending human-in-the-loop decisions with recommendation, rationale, evidence, approve/reject |
| Systems | External system (BGV / ITSM / payroll) connector status and tracking modes |
| Settings | Alert email, approver email, channel configuration, watcher health |
| Guardrails | Catalog of guardrail policies and log of blocked/escalated interventions |

**UI foundation:** custom design system (design tokens: color palette, spacing, radii, type scale, shadows), ~40 reusable UI primitives (shadcn/Radix-style: tables, dialogs, forms, tabs, charts, toasts, etc.), charting library, responsive layout, error boundaries.

### 1.2 Cost-Benefit Explorer (second web app)
Pre-sales / business-case modeling tool for HRO automation.

| Page | What it does |
|---|---|
| Overview dashboard | Model KPIs, intent distribution, recent scenarios |
| Intent Corpus + Intent detail | Searchable catalog of ~HR intents; create/edit/retire custom intents; per-intent flow tracer with SME overlay proposals, approvals, revocation, history |
| Flow Classes | Reference taxonomy (FC1–FC4: deterministic → frontier multi-agent) |
| Scenario Builder | Automation mix, costs, volumes, growth; rollup with variance, flow diagrams, 3-year view, build-cost breakdown, sensitivity, assumptions register |
| Compare Scenarios | Side-by-side business cases, baseline management, print/PDF one-pager |
| Global Assumptions | Rates, allocations, systems-of-record configuration |
| Calibration | Import operational actuals (form / CSV / raw logs), drift detection, saved overlays |

**Domain calculation engines (tested libraries):** scenario rollup, comparison, drift detection, token pricing, cost formatting/mapping.

### 1.3 Architecture slide deck (presentation artifact)
21-slide interactive deck presenting the target architecture, lifecycle stories, multi-tenancy, isolation tiers, pricing, and a ~26-week implementation timeline. (Content asset — minor build effort.)

---

## 2. Backend API server

Single API service (Node/TypeScript, Express-style) with auth middleware on every route.

| Route domain | ~Endpoints | Purpose |
|---|---|---|
| Corpus / metadata | 7 | Intents, flow classes, systems, profiles, model catalog, assumptions |
| Scenarios & rollups | 6 | Scenario CRUD + calculated business-case rollup |
| Flow overrides | 5 | Versioned SME cost/flow overrides (propose / revoke / history) |
| Actuals / log imports | 6 | Validate + import operational measurements, incl. multipart file ingestion |
| Custom intents | 6 | CRUD + retire with history preservation |
| Workbook | 3 | Excel export/import of the full model |
| Sensitivity analysis | 1 | Assumption sensitivity computation |
| Slide-deck export | 2 | PPTX generation/download |
| Onboarding / control tower | ~40 | Cases, events, communications, documents, records, approvals, connectors, settings, guardrails, analytics, channels, voice calls, demo/simulation |
| Webhooks | ~8 | Twilio WhatsApp inbound, Twilio voice (answer/turn/status), external system webhook, email-watch tick, heartbeat tick |

**Total: ~85 endpoints.**

---

## 3. Data model (PostgreSQL, 17 tables)

**Cost-explorer domain (4):** scenarios, flow_overrides (versioned), actuals_overlays, custom_intents (retirable).

**Onboarding domain (13):**
- `onb_cases` — central case record: worker profile, lifecycle + orchestration state, readiness, workstreams
- `onb_events` — append-only audit timeline with agent/engine/rule tags and idempotency keys
- `onb_approvals` — HITL approvals: recommendation, rationale, evidence, resume action, idempotency
- `onb_communications` — omnichannel timeline (email / WhatsApp / voice) with provider-message-ID dedup
- `onb_system_checks` — BGV / ITSM / payroll checks: tracking mode, SLA due dates, escalation state
- `onb_connectors` — connector catalog (API vs email-watch tracking)
- `onb_documents` — per-case document checklist (pending / received / verified)
- `onb_call_slots` — proposed/booked onboarding call slots
- `onb_voice_sessions` — durable live-call sessions: transcript, decisions, crash-safe finalization leases
- `onb_watch_emails` — processed vendor status emails (dedup by provider ID)
- `onb_employee_records` — archived employment stints (rehire analysis)
- `onb_guardrail_events` — guardrail intervention audit
- `onb_settings` — operational key/value settings

---

## 4. AI agents & LLM components

| Agent | What it does |
|---|---|
| **Orchestration engine** | Deterministic case lifecycle/readiness/workstream state machine; emits events + approvals; applies rule/HITL metadata; resumes after human decisions. Rules-first; invokes LLM agents for specialized flows |
| **Voice agent** | Live Twilio phone conversations (day-before check-in, SLA escalation); per-turn LLM JSON output (say / done / decision), bounded turns, durable transcript + idempotent finalization |
| **Inbound communication router** | Parses hire replies (email/WhatsApp), strips quoted text, recognizes intent, routes to scheduling / documents / status / orchestration actions |
| **Approver email agent** | Generates approval-request emails; parses trusted approver replies — only explicit approve/reject with a matching reference changes state |
| **Records / archive agent** | Converts natural-language questions about past employment into structured query plans; deterministic execution produces answers with evidence |
| **Narrative generator** | AI-written analytics summaries and employee-facing message drafts; degrades to templates on failure (never fabricates) |
| **LLM infrastructure** | Shared OpenAI wrapper (strict-JSON + text completion, graceful failure), model catalog for router/reasoning/frontier tiers |

**Azure mapping note:** these map naturally to Azure OpenAI Service + a durable orchestration layer (e.g. Durable Functions / Service Bus), but the orchestration engine, idempotency, and guardrail logic are custom build effort — not off-the-shelf.

---

## 5. Business rules & guardrails

- **HITL rule model:** every automated decision carries a rule reference + HITL pattern (auto-proceed / review / hard-block); hard-block patterns force human approval
- **Approval policy:** recommendations with rationale + evidence; explicit decision required to resume orchestration
- **SLA logic:** due-date tracking per external check; single-fire escalation events; escalation communications/calls
- **Guardrails:** block / sanitize / rate-limit / escalate / reject interventions, all audited
- **Duplicate-case prevention, channel-preference rules, sender allowlists** for inbound email acting on state

---

## 6. Background workers (all crash-safe / idempotent)

| Worker | Purpose |
|---|---|
| Heartbeat tick dispatcher | Single throttled entry point driving all pollers (survives serverless/autoscale pauses) |
| Hire-inbox Gmail poller | Reads hire replies, dedupes, routes intent |
| Approver-inbox Gmail poller | Scans approver mailbox for approve/reject replies |
| External-system watcher | Polls BGV/ITSM/payroll via API, email-watch, or webhook; detects overdue; fires SLA escalation |
| Vendor email-watch parser | Parses vendor status emails into system-check updates |
| Startup maintenance | Backfills, connector seeding, stale voice-session recovery |

---

## 7. External integrations

| Integration | Used for |
|---|---|
| **Twilio WhatsApp** | Outbound hire messaging + signed inbound webhook with message dedup |
| **Twilio Voice** | Live AI phone calls: answer/turn/status webhooks, durable session management |
| **Gmail (2 mailboxes)** | Hire-reply inbox + approver inbox polling; outbound email; echo-loop prevention |
| **Clerk** | Authentication/identity for the control tower (SSO-capable) |
| **OpenAI** | All LLM inference (chat + strict JSON), via managed proxy |

**Azure equivalents to price:** Azure Communication Services or Twilio-on-Azure, Microsoft Graph (Exchange) instead of Gmail, Entra ID instead of Clerk, Azure OpenAI instead of OpenAI.

---

## 8. Cross-cutting engineering (real effort, easy to under-estimate)

- **Generated, typed API contract:** OpenAPI spec → generated TypeScript client + runtime validation schemas shared by both frontends
- **Idempotency everywhere:** unique keys on events, approvals, communications, webhooks; atomic claim/lease patterns for voice sessions
- **Webhook durability:** owner-fenced finalization, replay-safe processing, signature validation
- **Audit trail:** append-only event log with agent/rule attribution
- **Test suites:** unit tests for calculation engines and UI behavior; e2e testing practice
- **Demo/simulation layer:** simulated calls, hire replies, seeded volunteers (needed for sales demos; optional for production)

---

## 9. Suggested estimation buckets

| Bucket | Contents |
|---|---|
| Control Tower frontend | 9 surfaces + design system + case workspace |
| Cost Explorer frontend | 8 surfaces + calculation engines |
| Core API + data model | ~85 endpoints, 17 tables, auth, audit |
| Orchestration engine + rules/HITL | State machine, approvals, SLA, guardrails |
| AI agents | Voice, inbound routing, approver parsing, records agent, narratives |
| Channel integrations | WhatsApp, voice telephony, dual-mailbox email |
| Background processing | 6 workers + durability/idempotency infrastructure |
| Platform | Identity, deployment, observability, environments |
