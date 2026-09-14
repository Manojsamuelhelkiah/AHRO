const cols: { title: string; color: string; items: [string, string][] }[] = [
  {
    title: 'Hardware & Capacity',
    color: '#7ac9f5',
    items: [
      ['No client hardware in SaaS tiers', 'all compute is cloud-hosted; employees only need a browser or Teams'],
      ['Model capacity', 'Azure OpenAI provisioned throughput (PTU) for predictable latency · pay-as-you-go burst for peaks'],
      ['App compute', 'AKS / Container Apps — autoscaling agent runtime, ~2–4 vCPU per 1k active employees as a starting point'],
      ['GPU', 'none owned — GPU is consumed via the model services, never managed directly'],
      ['Dedicated tier sizing', 'sized per client: employee count, case volume, document OCR load'],
    ],
  },
  {
    title: 'Software Stack',
    color: '#8fd6a8',
    items: [
      ['AI platform', 'Azure AI Foundry (agents, evals) · Azure OpenAI · Document Intelligence · Speech · Content Safety'],
      ['Runtime & orchestration', 'Semantic Kernel / Foundry Agent Service · MCP servers · A2A messaging on Service Bus'],
      ['Data layer', 'Cosmos DB (memory & cases) · AI Search (vectors & policy index) · Blob storage (documents)'],
      ['Integration', 'API Management (gateway) · Logic Apps connectors · certified HCM connector pack'],
      ['Insight & ops', 'Microsoft Fabric + Power BI · Azure Monitor + App Insights · IaC via Bicep/Terraform'],
    ],
  },
  {
    title: 'Infra & Network',
    color: '#d9b36a',
    items: [
      ['Landing zone', 'per-region Azure landing zone · tenant-tagged resources · release rings across regions'],
      ['Network', 'private endpoints & VNet integration · no public data path in Tier 2/3 · TLS everywhere'],
      ['Identity', 'Entra ID federation with client IdP (SSO) · Entra Agent ID for every agent · Key Vault / BYOK'],
      ['Resilience', 'zone-redundant services · cross-region DR for dedicated tiers · RPO/RTO per SLA tier'],
      ['Environments', 'dev / staging / prod per release ring · tenant sandbox for client UAT before go-live'],
    ],
  },
  {
    title: 'Client-Side Prerequisites',
    color: '#e08a8a',
    items: [
      ['Channels', 'Microsoft 365 with Teams (or web portal fallback) · mail routing for the email channel · WhatsApp Business number for the messaging channel'],
      ['Identity', 'Entra ID (or SAML/OIDC IdP) for SSO · agreed role mapping for HITL approvers'],
      ['System access', 'API credentials for HCM, payroll, benefits, ticketing — least-privilege service accounts'],
      ['Data feeds', 'HR policy documents per country · org & employee master data sync'],
      ['Network', 'egress allow-listing or private connectivity (ExpressRoute / VPN) for Tier 2/3'],
    ],
  },
];

import { Slide17 } from '../../components/BusinessDeck';

export default Slide17;

export function LegacyRequirements() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[99vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3vw] py-[3.2vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Hardware, Software &amp; Infrastructure Requirements
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            everything runs on Azure — clients bring identity, channels &amp;
            system access
          </p>
        </div>
        <div className="grid grid-cols-4 gap-[0.9vw] mt-[1.6vh] flex-1 min-h-0">
          {cols.map((c) => (
            <div
              key={c.title}
              className="rounded-[0.6vw] border bg-[#0d1e36] px-[0.9vw] py-[0.9vh] flex flex-col min-h-0"
              style={{ borderColor: c.color }}
            >
              <p
                className="font-display font-bold text-[1.2vw]"
                style={{ color: c.color }}
              >
                {c.title}
              </p>
              <div className="mt-[0.6vh] flex flex-col gap-[0.6vh] flex-1 min-h-0">
                {c.items.map(([t, d]) => (
                  <div
                    key={t}
                    className="flex-1 bg-[#12233f] border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.5vh] flex flex-col justify-center"
                  >
                    <p className="font-display font-semibold text-text text-[1vw]">
                      {t}
                    </p>
                    <p className="font-body text-muted text-[0.95vw] leading-snug">
                      {d}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
