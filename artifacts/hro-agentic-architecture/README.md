# Autonomous HRO Agentic Architecture — Slide Deck

This deck is hand-authored. It does **not** update automatically when the
products change, so after any major feature lands in the Onboarding Agent
Control Tower, the API Server, or the Cost-Benefit Explorer, run through the
sync checklist below and update the affected slides.

Slide list & order live in `src/data/slides-manifest.json`; each entry points
to a component in `src/pages/slides/`.

## Slide sync checklist

After shipping a major product change, check the row(s) whose product area
changed and update the listed slides:

| Product area changed | Slides to review |
| --- | --- |
| Channels (Teams, web, email, WhatsApp, voice — new channel or channel behavior) | `ExperienceIntake.tsx`, `ArchitectureDiagram.tsx` (band 1), `FunctionalView.tsx` (band 1), `Requirements.tsx` (client-side prerequisites) |
| Intake / multimodal ingestion | `ExperienceIntake.tsx`, `ArchitectureDiagram.tsx` |
| Intent catalog, routing, multi-agent loops | `IntentRouting.tsx`, `FunctionalView.tsx` |
| Agents & orchestration (new agents such as the System Watcher, MCP tools, reasoning tiers) | `BrainAndHands.tsx`, `ArchitectureDiagram.tsx`, `TrustFabric.tsx` (if the agent is a monitoring/guardrail concern) |
| Security, identity, guardrails, observability, self-monitoring & HR alerting | `TrustFabric.tsx`, `ArchitectureDiagram.tsx` (cross-cutting rail), `Requirements.tsx` |
| Case management, SLA tracking, escalation, human-in-the-loop | `FunctionalView.tsx`, `FlowPayroll.tsx`, `FlowMobility.tsx` |
| End-to-end lifecycle flows (new flow or changed as-is/to-be story) | `FlowPayslip.tsx`, `FlowPolicy.tsx`, `FlowPayroll.tsx`, `FlowMobility.tsx` |
| Multi-tenancy, isolation tiers, delivery model | `MultiTenant.tsx`, `IsolationTiers.tsx`, `DeliveryModel.tsx`, `ProductConsiderations.tsx` |
| Core / Configurable / Custom demarcation (badges in the cost explorer) | `Demarcation.tsx`, `ProductConsiderations.tsx` |
| Pricing models, tier multipliers, add-ons | `Pricing.tsx`, and `Demarcation.tsx` if the demarcation of a priced item moved |
| Hardware / software / infrastructure requirements | `Requirements.tsx` |
| Implementation timeline & rollout phases | `Timeline.tsx` |
| Legal & product documentation obligations | `LegalDocs.tsx` |
| Reporting, dashboards, autonomy metrics | `InsightImpact.tsx`, `FunctionalView.tsx` (always-on rail) |

## How to update

1. Edit the relevant component(s) in `src/pages/slides/`.
2. If a slide's title or scope changes, update its `title`/`description` in
   `src/data/slides-manifest.json` (keep `id` and `filepath` stable).
3. Preview the deck and confirm the changed slides still fit their layout
   (text uses viewport units — long additions can overflow).

## Note on demo vs. target architecture

The deck presents the **target** Azure/Microsoft-stack architecture. The demo
apps in this workspace intentionally differ in some implementation details
(e.g. Clerk for control-tower sign-in, Gmail + Twilio WhatsApp as concrete
channel providers). Keep the deck at the target-architecture level; only pull
demo details in when they represent a real capability change (e.g. the
WhatsApp channel, the System Watcher agent, HR outage alert emails).
