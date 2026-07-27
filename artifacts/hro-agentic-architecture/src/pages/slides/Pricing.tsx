const models = [
  {
    name: 'PEPM Subscription',
    color: '#7ac9f5',
    tag: 'Primary model',
    what: 'Per employee served, per month — all-you-can-ask within fair use',
    points: [
      'Predictable for CHRO budgets · scales with workforce size',
      'Includes standard flows, policy Q&A, case handling',
      'Fair-use token cap with transparent overage',
    ],
    fit: 'Best for: enterprise-wide deployments',
  },
  {
    name: 'Per Resolved Case',
    color: '#8fd6a8',
    tag: 'Outcome-based',
    what: 'Pay only when the platform fully resolves a case end-to-end',
    points: [
      'Zero-risk entry — aligned to deflection value',
      'Human-escalated cases billed at a reduced rate',
      'Rate card by case complexity (Flow 1 ≠ Flow 4)',
    ],
    fit: 'Best for: pilots & value-proof phases',
  },
  {
    name: 'Platform + Usage',
    color: '#d9b36a',
    tag: 'Dedicated tiers',
    what: 'Annual platform fee + metered usage (tokens, cases, storage)',
    points: [
      'Covers dedicated infrastructure & compliance overhead',
      'Minimum commitment · multi-year discounts',
      'Client sees the same cost telemetry we do',
    ],
    fit: 'Best for: Tier 3 regulated clients',
  },
];

export default function Pricing() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[99vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3.5vw] py-[3.2vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Pricing Models &amp; Options
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            price the outcome, meter the cost, protect the margin
          </p>
        </div>

        <div className="grid grid-cols-3 gap-[1vw] mt-[1.6vh]" style={{ flex: 3, minHeight: 0 }}>
          {models.map((m) => (
            <div
              key={m.name}
              className="rounded-[0.6vw] border bg-[#0d1e36] px-[1vw] py-[1vh] flex flex-col"
              style={{ borderColor: m.color }}
            >
              <div className="flex items-center justify-between">
                <p className="font-display font-bold text-[1.3vw]" style={{ color: m.color }}>
                  {m.name}
                </p>
                <span
                  className="font-body text-[0.9vw] rounded-full px-[0.7vw] py-[0.2vh] border"
                  style={{ color: m.color, borderColor: m.color }}
                >
                  {m.tag}
                </span>
              </div>
              <p className="font-body text-text text-[1.05vw] leading-snug mt-[0.6vh]">
                {m.what}
              </p>
              <div className="mt-[0.6vh] flex flex-col gap-[0.5vh] flex-1">
                {m.points.map((p) => (
                  <p key={p} className="font-body text-muted text-[1vw] leading-snug">
                    · {p}
                  </p>
                ))}
              </div>
              <p className="font-body text-accent text-[1vw] mt-[0.5vh]">{m.fit}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-[1vw] mt-[1vh]" style={{ flex: 2, minHeight: 0 }}>
          <div className="bg-[#111f38] border border-[#24406b] rounded-[0.6vw] px-[1vw] py-[0.8vh]">
            <p className="font-display font-bold text-accent text-[1.2vw]">
              Tier multipliers &amp; add-ons
            </p>
            <div className="mt-[0.5vh] flex flex-col gap-[0.4vh]">
              <p className="font-body text-muted text-[1.02vw] leading-snug">
                <span className="text-text font-semibold">Isolation tier uplift</span> — Pooled 1.0× · Siloed Data ~1.3–1.5× · Dedicated ~2–3× (infra passed through + ops premium)
              </p>
              <p className="font-body text-muted text-[1.02vw] leading-snug">
                <span className="text-text font-semibold">Add-ons</span> — extra HCM connectors · premium deep-reasoning quota · additional languages · managed HITL desk · advanced analytics pack
              </p>
              <p className="font-body text-muted text-[1.02vw] leading-snug">
                <span className="text-text font-semibold">Onboarding</span> — one-time implementation fee, credited back on multi-year commitment
              </p>
            </div>
          </div>
          <div className="bg-[#111f38] border border-[#24406b] rounded-[0.6vw] px-[1vw] py-[0.8vh]">
            <p className="font-display font-bold text-accent text-[1.2vw]">
              Commercial guardrails
            </p>
            <div className="mt-[0.5vh] flex flex-col gap-[0.4vh]">
              <p className="font-body text-muted text-[1.02vw] leading-snug">
                <span className="text-text font-semibold">Token economics</span> — fair-use bands per employee; model cost pass-through above band keeps margin safe as usage grows
              </p>
              <p className="font-body text-muted text-[1.02vw] leading-snug">
                <span className="text-text font-semibold">SLA credits</span> — uptime &amp; resolution-time commitments per tier, credited automatically from metering data
              </p>
              <p className="font-body text-muted text-[1.02vw] leading-snug">
                <span className="text-text font-semibold">Value ratchet</span> — annual price review indexed to measured deflection &amp; satisfaction, not seat count alone
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
