# Autonomous HRO Onboarding App — Component Inventory for Effort Estimation

**Scope:** Only the Autonomous HRO onboarding product (Control Tower + its backend). Excludes the Cost-Benefit Explorer and the architecture slide deck.

**Purpose:** A build-scope inventory to price a re-build as a real product on another platform (e.g. Azure).

**Date:** August 14, 2026

---

## 1. Control Tower web application (HR-facing console)

| Page / Surface | What it does |
|---|---|
| Login / Auth shell | Branded sign-in (Clerk-hosted identity), demo-login flow |
| Control Tower Dashboard | Live operational overview: case pipeline, approvals, system health |
| Cases list | Filterable case pipeline with status, owner (AI vs human), New Case form with validation and duplicate-case protection |
| Case Details workspace | Sticky header + case-health strip; tabs: Overview, Tasks, Documents, Activity, Communications, Audit; approvals rail; Take Action menu (incl. initiating a live voice call) |
| HRO Intelligence (Analytics) | Autonomy rate, review-volume drivers, Day-1 risk, policy-exception analysis, AI-written narrative summary |
| Approvals inbox | Pending human-in-the-loop decisions with recommendation, rationale, evidence, approve/reject |
| Systems | External system (BGV / ITSM / payroll) connector status and tracking modes |
| Settings | Alert email, approver email, channel configuration, watcher health |
| Guardrails | Catalog of guardrail policies and log of blocked/escalated interventions |

**UI foundation (build once, used everywhere):**
- Custom design system: design tokens for color palette, spacing, radii, type scale, shadows
- ~40 reusable UI primitives (tables, dialogs, forms, tabs, charts, toasts, dropdowns, etc.)
- Charting, responsive layout, error boundaries, toast notifications
- Branded authentication theming

---

## 2. Backend API service

Node/TypeScript API with authentication middleware on every route.

| Route domain | ~Endpoints | Purpose |
|---|---|---|
| Cases | ~10 | Create/list/detail cases; events, communications, documents, records subresources; inbound case messages |
| Approvals | 2 | List pending approvals; record decisions (resumes orchestration) |
| Analytics & dashboard | ~4 | Dashboard rollups, analytics metrics, AI narrative |
| Connectors & systems | ~4 | Connector catalog, tracking-mode updates, system/watcher status |
| Settings & channels | ~5 | Operational settings, channel configuration, test alerts |
| Guardrails | 3 | Guardrail catalog, event log, drill-down |
| Voice calls | ~3 | Initiate live calls, session progress |
| Historical record protections | ~3 | Restricted login and read-only history; permanent offline dispatch denial |
| Webhooks | ~8 | Twilio WhatsApp inbound; Twilio voice answer/turn/status; external-system webhook; email-watch tick; heartbeat tick |
| Health | 1 | Health check |

**Total: ~45–50 endpoints.**

---

## 3. Data model (PostgreSQL, 13 tables)

- `onb_cases` — central case record: worker profile, contact channels, lifecycle + orchestration state, readiness, workstreams
- `onb_events` — append-only audit timeline with agent/engine/rule tags and idempotency keys
- `onb_approvals` — human-in-the-loop approvals: recommendation, rationale, evidence, resume action, idempotency
- `onb_communications` — omnichannel timeline (email / WhatsApp / voice) with provider-message-ID dedup
- `onb_system_checks` — BGV / ITSM / payroll checks: tracking mode, SLA due dates, escalation state
- `onb_connectors` — connector/vendor catalog (API vs email-watch tracking)
- `onb_documents` — per-case document checklist (pending / received / verified)
- `onb_call_slots` — proposed/booked onboarding call slots with dedup keys
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
| **LLM infrastructure** | Shared OpenAI wrapper (strict-JSON + text completion, graceful failure handling) |

**Azure mapping note:** these map to Azure OpenAI Service plus a durable orchestration layer (e.g. Durable Functions / Service Bus), but the orchestration engine, idempotency, and guardrail logic are custom build effort — not off-the-shelf.

---

## 5. Business rules & guardrails

- **HITL rule model:** every automated decision carries a rule reference + HITL pattern (auto-proceed / review / hard-block); hard-block patterns force human approval
- **Approval policy:** recommendations with rationale + evidence; explicit human decision required before orchestration resumes
- **SLA logic:** due-date tracking per external check; single-fire escalation events; escalation communications/calls
- **Guardrails:** block / sanitize / rate-limit / escalate / reject interventions, all audited
- **Safety rules:** duplicate-case prevention, channel-preference rules, sender allowlists before any inbound email may change state

---

## 6. Background workers (all crash-safe / idempotent)

| Worker | Purpose |
|---|---|
| Heartbeat tick dispatcher | Single throttled entry point driving all pollers (survives serverless/autoscale pauses) |
| Hire-inbox email poller | Reads hire replies, dedupes, routes intent |
| Approver-inbox email poller | Scans approver mailbox for approve/reject replies |
| External-system watcher | Polls BGV/ITSM/payroll via API, email-watch, or webhook; detects overdue; fires SLA escalation |
| Vendor email-watch parser | Parses vendor status emails into system-check updates |
| Startup maintenance | Backfills, connector seeding, stale voice-session recovery |

---

## 7. External integrations

| Integration | Used for | Azure equivalent to price |
|---|---|---|
| **Twilio WhatsApp** | Outbound hire messaging + signed inbound webhook with dedup | Azure Communication Services or Twilio-on-Azure |
| **Twilio Voice** | Live AI phone calls: answer/turn/status webhooks, durable sessions | Azure Communication Services Calling / Twilio |
| **Gmail (2 mailboxes)** | Hire-reply inbox + approver inbox polling; outbound email; echo-loop prevention | Microsoft Graph (Exchange Online) |
| **Clerk** | Authentication/identity (SSO-capable) | Microsoft Entra ID |
| **OpenAI** | All LLM inference (chat + strict JSON) | Azure OpenAI Service |

---

## 8. Cross-cutting engineering (real effort, easy to under-estimate)

- **Typed API contract:** OpenAPI spec → generated typed client + runtime validation shared with the frontend
- **Idempotency everywhere:** unique keys on events, approvals, communications, webhooks; atomic claim/lease patterns for voice sessions so a crashed call never loses or double-counts an outcome
- **Webhook durability:** owner-fenced finalization, replay-safe processing, provider signature validation
- **Audit trail:** append-only event log with agent/rule attribution
- **Testing:** unit tests for business logic and UI behavior; e2e testing practice
- **Historical record protections:** restricted evidence access, permanent offline dispatch denial, preserved provenance and exclusion from live outcomes

---

## 9. Suggested estimation buckets

| Bucket | Contents |
|---|---|
| Control Tower frontend | 9 surfaces + design system + case workspace |
| Core API + data model | ~45–50 endpoints, 13 tables, auth, audit |
| Orchestration engine + rules/HITL | State machine, approvals, SLA, guardrails |
| AI agents | Voice, inbound routing, approver parsing, records agent, narratives |
| Channel integrations | WhatsApp, voice telephony, dual-mailbox email |
| Background processing | 6 workers + durability/idempotency infrastructure |
| Platform | Identity, deployment, observability, environments |
