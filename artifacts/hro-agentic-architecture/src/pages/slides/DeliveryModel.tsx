export default function DeliveryModel() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[98vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3.5vw] py-[3.5vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            SaaS or On-Prem? — Operated as SaaS in Every Tier
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            the real question is where the boundary of your data sits
          </p>
        </div>

        <div className="grid grid-cols-2 gap-[1.2vw] mt-[1.8vh]">
          <div className="bg-[#0e2440] border border-[#2f5c94] rounded-[0.6vw] px-[1.2vw] py-[1.2vh]">
            <p className="font-display font-bold text-accent text-[1.35vw]">
              Why the platform must be operated as SaaS
            </p>
            <div className="mt-[0.8vh] flex flex-col gap-[0.7vh]">
              {[
                ['The product improves weekly', 'agent quality depends on continuous evals, prompt & guardrail updates — a frozen on-prem install degrades from day one'],
                ['Frontier models don’t live on-prem', 'deep reasoning needs top-tier Azure-served models; disconnected installs are limited to weaker local models'],
                ['Safety is a 24/7 operation', 'red teaming, jailbreak patching and incident response are provider duties — not a client IT workload'],
                ['Economics only work pooled', 'shared model pool, gateway and runtime are what make per-employee pricing viable'],
              ].map(([t, d]) => (
                <p key={t} className="font-body text-[1.08vw] leading-snug text-muted">
                  <span className="text-text font-semibold">{t}</span> — {d}
                </p>
              ))}
            </div>
          </div>

          <div className="bg-[#111f38] border border-[#24406b] rounded-[0.6vw] px-[1.2vw] py-[1.2vh]">
            <p className="font-display font-bold text-[#d9b36a] text-[1.35vw]">
              What “we need on-prem” usually means — and the answer
            </p>
            <div className="mt-[0.8vh] flex flex-col gap-[0.7vh]">
              {[
                ['“Our data can’t leave”', 'Tier 2/3: data pinned to your region or your own Azure subscription — provider never holds it pooled'],
                ['“We control the keys”', 'BYOK / client-managed keys in every dedicated tier · private endpoints, no public network path'],
                ['“Auditors must inspect it”', 'dedicated tier grants auditor access, full audit trail, model cards & explainability reports'],
                ['“No shared infrastructure”', 'Tier 3 deploys the entire stack into a client-owned subscription — private SaaS, still provider-operated'],
              ].map(([t, d]) => (
                <p key={t} className="font-body text-[1.08vw] leading-snug text-muted">
                  <span className="text-text font-semibold">{t}</span> — {d}
                </p>
              ))}
            </div>
          </div>
        </div>

        {/* Split data plane */}
        <div className="flex-1 min-h-0 mt-[1.2vh] bg-[#0f2a47] border border-[#2f5c94] rounded-[0.6vw] px-[1.2vw] py-[1vh] flex flex-col">
          <div className="flex items-center justify-between">
            <p className="font-display font-bold text-accent text-[1.35vw]">
              The legitimate hybrid — split data plane
            </p>
            <p className="font-body text-muted text-[1.05vw]">
              defuses data sovereignty without forking the product
            </p>
          </div>
          <div className="flex items-center gap-[0.8vw] mt-[0.8vh] flex-1 min-h-0">
            <div className="flex-1 bg-[#12233f] border border-[#8fd6a8] rounded-[0.5vw] px-[1vw] py-[0.8vh] h-full flex flex-col justify-center">
              <p className="font-display font-bold text-[#8fd6a8] text-[1.15vw]">
                Client environment
              </p>
              <p className="font-body text-text text-[1.05vw] leading-snug">
                HR data, case files, memory, policy library, HCM connectors —
                everything stateful stays inside the client boundary
              </p>
            </div>
            <div className="shrink-0 text-center">
              <p className="font-body text-accent text-[1.05vw]">
                PII redacted at the boundary →
              </p>
              <p className="font-body text-muted text-[0.95vw]">
                ← answers only
              </p>
            </div>
            <div className="flex-1 bg-[#12233f] border border-[#7ac9f5] rounded-[0.5vw] px-[1vw] py-[0.8vh] h-full flex flex-col justify-center">
              <p className="font-display font-bold text-[#7ac9f5] text-[1.15vw]">
                Provider model pool
              </p>
              <p className="font-body text-text text-[1.05vw] leading-snug">
                stateless reasoning calls only — no retention, no training on
                client data, frontier models always current
              </p>
            </div>
          </div>
        </div>

        <p className="font-body text-muted text-[1.05vw] text-right mt-[0.8vh]">
          Position: <span className="text-text">SaaS-first · “private SaaS in
          your cloud” for regulated clients · classic disconnected on-prem is a
          worse product, not a cheaper one</span>
        </p>
      </div>
    </div>
  );
}
