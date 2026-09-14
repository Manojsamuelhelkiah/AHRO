const groups: { title: string; items: [string, string][] }[] = [
  {
    title: 'Isolation & Trust',
    items: [
      ['Tenant isolation tiers', 'pooled, siloed DB, or dedicated deployment — priced accordingly'],
      ['Per-tenant encryption keys', 'client-managed keys; agents can never cross tenant boundaries'],
      ['No cross-tenant learning', 'one client’s data never tunes models or prompts for another'],
    ],
  },
  {
    title: 'Compliance & Residency',
    items: [
      ['Data residency', 'EU data stays in EU regions — deployable per geography'],
      ['Certifications', 'SOC 2, ISO 27001, GDPR; AI-specific: EU AI Act readiness'],
      ['Works councils & unions', 'per-country consent, transparency and audit obligations'],
    ],
  },
  {
    title: 'Commercial Model',
    items: [
      ['Pricing & metering', 'per employee served / per resolved case — with token cost visibility'],
      ['SLAs per tier', 'response, resolution and uptime commitments with credits'],
      ['Cost governance', 'per-tenant budgets and alerts so one client can’t burn the margin'],
    ],
  },
  {
    title: 'Operations at Scale',
    items: [
      ['Tenant admin console', 'clients manage their own policies, personas, approvers, intents'],
      ['Per-tenant quality', 'evals, deflection and satisfaction tracked per client, not just globally'],
      ['Incident model', 'tenant-aware on-call, status pages and breach notification duties'],
    ],
  },
  {
    title: 'Customization vs Core',
    items: [
      ['Config, not forks', '80% product, 20% per-client config: intents, playbooks, connectors'],
      ['Connector marketplace', 'certified HCM / payroll / ticketing connectors, versioned per tenant'],
      ['Upgrade safety', 'tenant-level regression evals before any model or prompt rollout'],
    ],
  },
  {
    title: 'Go-to-Market',
    items: [
      ['Onboarding factory', 'policy import, connector setup, HITL role mapping — days not months'],
      ['Trust artifacts', 'model cards, audit logs, explainability reports for client security reviews'],
      ['Exit & portability', 'clients can leave with their data, cases and policy library intact'],
    ],
  },
];

import { Slide13 } from '../../components/BusinessDeck';

export default Slide13;

export function LegacyProductConsiderations() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[95vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3.5vw] py-[3.5vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Running It as a Product — What Else Must Be True
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            the checklist that separates a client solution from a sellable
            platform
          </p>
        </div>
        <div className="grid grid-cols-3 grid-rows-2 gap-[1vw] mt-[1.8vh] flex-1 min-h-0">
          {groups.map((g) => (
            <div
              key={g.title}
              className="bg-[#111f38] border border-[#24406b] rounded-[0.6vw] px-[1vw] py-[1vh] flex flex-col"
            >
              <p className="font-display font-bold text-accent text-[1.25vw] tracking-wide">
                {g.title}
              </p>
              <div className="mt-[0.7vh] flex flex-col gap-[0.7vh]">
                {g.items.map(([t, d]) => (
                  <p
                    key={t}
                    className="font-body text-[1.02vw] leading-snug text-muted"
                  >
                    <span className="text-text font-semibold">{t}</span> — {d}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
