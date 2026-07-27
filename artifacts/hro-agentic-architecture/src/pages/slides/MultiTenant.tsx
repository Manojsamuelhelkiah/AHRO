const cell = 'bg-[#0f2a47] border border-[#2f5c94] rounded-[0.5vw]';

function TenantCol({
  name,
  color,
  industry,
}: {
  name: string;
  color: string;
  industry: string;
}) {
  return (
    <div
      className="flex-1 rounded-[0.6vw] border px-[0.9vw] py-[0.9vh] flex flex-col gap-[0.6vh]"
      style={{ borderColor: color, backgroundColor: '#0d1e36' }}
    >
      <div className="flex items-baseline justify-between">
        <p
          className="font-display font-bold text-[1.25vw]"
          style={{ color }}
        >
          {name}
        </p>
        <p className="font-body text-muted text-[0.95vw]">{industry}</p>
      </div>
      <div className="bg-[#12233f] border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.5vh]">
        <p className="font-body text-text text-[1vw] leading-snug">
          Branded personas &amp; channels — client look, tone, languages
        </p>
      </div>
      <div className="bg-[#12233f] border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.5vh]">
        <p className="font-body text-text text-[1vw] leading-snug">
          Own policy library, intents &amp; playbooks — per country, per union
          agreement
        </p>
      </div>
      <div className="bg-[#12233f] border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.5vh]">
        <p className="font-body text-text text-[1vw] leading-snug">
          Isolated data, memory &amp; case files — encrypted per tenant, own
          keys
        </p>
      </div>
      <div className="bg-[#12233f] border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.5vh]">
        <p className="font-body text-text text-[1vw] leading-snug">
          Own HCM connectors — Workday here, SuccessFactors there
        </p>
      </div>
    </div>
  );
}

export default function MultiTenant() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute inset-0 flex flex-col px-[3.5vw] py-[3.5vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            From Solution to Product — Multi-Tenant by Design
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            one product · many clients · hard isolation where it matters
          </p>
        </div>

        {/* Control plane */}
        <div className={`${cell} mt-[1.6vh] px-[1vw] py-[0.8vh]`}>
          <div className="flex items-center justify-between">
            <p className="font-display font-bold text-accent text-[1.2vw]">
              Product Control Plane — shared, run by the provider
            </p>
            <p className="font-body text-accent text-[1vw]">
              one codebase, one release train, per-tenant configuration
            </p>
          </div>
          <div className="grid grid-cols-5 gap-[0.7vw] mt-[0.6vh]">
            {[
              ['Tenant Onboarding Factory', 'provision a new client in days: config, connectors, policy import'],
              ['Release Rings', 'canary → early adopters → all tenants · feature flags per tenant'],
              ['Shared Model Pool', 'central model catalog & upgrades · per-tenant routing and pinning'],
              ['Central Evals & Guardrails', 'baseline safety and quality bars no tenant can lower'],
              ['Metering & Billing', 'per-tenant usage, token cost, SLA credits, invoicing'],
            ].map(([t, d]) => (
              <div
                key={t}
                className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.5vh]"
              >
                <p className="font-display font-bold text-text text-[1vw]">
                  {t}
                </p>
                <p className="font-body text-muted text-[0.9vw] leading-snug">
                  {d}
                </p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-center leading-none text-[#3d6db3] text-[1.1vw] my-[0.3vh]">
          ▼
        </div>

        {/* Tenant planes */}
        <div className="flex gap-[1vw] flex-1 min-h-0">
          <TenantCol name="Client A" color="#7ac9f5" industry="Retail · 40k employees" />
          <TenantCol name="Client B" color="#8fd6a8" industry="Manufacturing · 12 countries" />
          <TenantCol name="Client C" color="#d9b36a" industry="Financial services · regulated" />
        </div>

        <div className="flex justify-center leading-none text-[#3d6db3] text-[1.1vw] my-[0.3vh]">
          ▼
        </div>

        {/* Shared foundation */}
        <div className="bg-[#12233f] border border-[#24406b] rounded-[0.5vw] px-[1vw] py-[0.8vh] flex items-center justify-between">
          <p className="font-display font-bold text-text text-[1.15vw]">
            Shared Foundation
          </p>
          <p className="font-body text-accent text-[1.05vw]">
            agent runtime · MCP registry · gateway · observability — tenant-tagged
            end-to-end, noisy-neighbor quotas per tenant
          </p>
        </div>

        <p className="font-body text-muted text-[1vw] text-right mt-[0.6vh]">
          Isolation choices per tier: shared-with-row-level-isolation → dedicated
          database → fully dedicated deployment (regulated clients)
        </p>
      </div>
    </div>
  );
}
