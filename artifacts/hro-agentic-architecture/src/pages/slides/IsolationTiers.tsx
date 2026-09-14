const tiers = [
  {
    name: 'Tier 1 · Pooled',
    color: '#7ac9f5',
    tagline: 'Shared everything, row-level isolation',
    rows: [
      'Shared app, database & model pool — every row tenant-tagged, enforced at the query layer',
      'Encryption per tenant · strict RBAC · noisy-neighbor quotas',
      'Standard compliance (SOC 2, GDPR) — no special residency demands',
      'Lowest cost per employee · best margin',
      'Onboarding in days · instant upgrades for all',
      'Best for: mid-market clients with standard requirements',
    ],
  },
  {
    name: 'Tier 2 · Siloed Data',
    color: '#8fd6a8',
    tagline: 'Shared app, dedicated database & storage',
    rows: [
      'Shared runtime & release train — but each client gets their own database, vector store & case files',
      'Client-managed encryption keys (BYOK) · isolated backups & retention',
      'Meets data residency — database pinned to client’s region',
      'Moderate cost premium · priced into the tier',
      'Onboarding in 1–2 weeks · upgrades per release ring',
      'Best for: enterprises with residency or works-council demands',
    ],
  },
  {
    name: 'Tier 3 · Dedicated',
    color: '#d9b36a',
    tagline: 'Fully dedicated deployment',
    rows: [
      'Entire stack — runtime, models, gateway, data — deployed into a dedicated (or client-owned) cloud subscription',
      'Client controls keys, network, private endpoints · optional air-gap from provider',
      'Regulated industries: banking, insurance, public sector · auditor access',
      'Highest cost · premium pricing & minimum commitments',
      'Onboarding in weeks · upgrades scheduled with the client',
      'Best for: regulated clients where shared infrastructure is a non-starter',
    ],
  },
];

const rowLabels = [
  'What is shared',
  'Security & keys',
  'Compliance fit',
  'Cost profile',
  'Speed & upgrades',
  'Typical client',
];

import { Slide15 } from '../../components/BusinessDeck';

export default Slide15;

export function LegacyIsolationTiers() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[97vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3.5vw] py-[3.5vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Choosing an Isolation Tier — Cost vs Control
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            one product, three deployment shapes — sold as tiers
          </p>
        </div>

        <div className="flex gap-[1vw] mt-[1.8vh] flex-1 min-h-0">
          {/* row labels */}
          <div className="w-[9vw] flex flex-col shrink-0">
            <div className="h-[7.5vh]" />
            <div className="flex-1 flex flex-col gap-[0.7vh]">
              {rowLabels.map((l) => (
                <div key={l} className="flex-1 flex items-center">
                  <p className="font-display font-bold text-muted text-[1vw] uppercase tracking-wide leading-tight">
                    {l}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {tiers.map((t) => (
            <div
              key={t.name}
              className="flex-1 flex flex-col rounded-[0.6vw] border overflow-hidden"
              style={{ borderColor: t.color, backgroundColor: '#0d1e36' }}
            >
              <div
                className="px-[1vw] py-[1vh] h-[7.5vh] flex flex-col justify-center"
                style={{ backgroundColor: `${t.color}1a` }}
              >
                <p className="font-display font-bold text-[1.3vw]" style={{ color: t.color }}>
                  {t.name}
                </p>
                <p className="font-body text-muted text-[1vw]">{t.tagline}</p>
              </div>
              <div className="flex-1 flex flex-col gap-[0.7vh] px-[0.9vw] py-[0.7vh]">
                {t.rows.map((r, i) => (
                  <div
                    key={i}
                    className="flex-1 bg-[#12233f] border border-[#24406b] rounded-[0.4vw] px-[0.8vw] flex items-center"
                  >
                    <p className="font-body text-text text-[1.02vw] leading-snug">
                      {r}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="font-body text-muted text-[1vw] text-right mt-[0.6vh]">
          Same codebase and release train in every tier — only the deployment
          boundary changes
        </p>
      </div>
    </div>
  );
}
