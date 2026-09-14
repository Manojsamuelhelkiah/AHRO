import { Slide02 } from '../../components/BusinessDeck';

export default Slide02;

const band = 'bg-[#12233f] border border-[#24406b] rounded-[0.5vw]';
const cell = 'bg-[#0f2a47] border border-[#2f5c94] rounded-[0.5vw]';
const rail = 'bg-[#16273f] border border-[#2a4568] rounded-[0.5vw]';

function Num({ n }: { n: string }) {
  return (
    <span className="inline-flex items-center justify-center w-[1.5vw] h-[1.5vw] rounded-full bg-[#2f81f7] text-white font-display font-bold text-[1.05vw] mr-[0.6vw] shrink-0">
      {n}
    </span>
  );
}

function Arrow() {
  return (
    <div className="flex justify-center leading-none text-[#3d6db3] text-[1.1vw] -my-[0.35vh]">
      ▼
    </div>
  );
}

export function LegacyArchitectureDiagram() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute inset-0 flex flex-col px-[3.2vw] py-[3.2vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Reference Architecture — One View
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            Azure &amp; Microsoft stack · MCP + A2A native · numbered = request
            path
          </p>
        </div>

        <div className="flex gap-[1.1vw] mt-[1.6vh] flex-1 min-h-0">
          {/* ===== main flow column ===== */}
          <div className="flex-1 flex flex-col min-h-0 gap-[0.7vh]">
            {/* 1 Experience */}
            <div className={`${band} px-[1vw] py-[0.8vh] flex items-center justify-between`}>
              <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                <Num n="1" />
                Experience — AI personas &amp; proactive journeys
                <span className="font-body font-normal text-muted text-[1.1vw] ml-[0.6vw]">
                  Teams · web · email · WhatsApp · voice ·
                  joiner-mover-leaver event triggers
                </span>
              </p>
              <p className="font-body text-accent text-[1.1vw]">
                Copilot Studio · Foundry Agents
              </p>
            </div>
            <Arrow />
            {/* 2 Gateway */}
            <div className={`${band} px-[1vw] py-[0.8vh] flex items-center justify-between`}>
              <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                <Num n="2" />
                AI Gateway
                <span className="font-body font-normal text-muted text-[1.1vw] ml-[0.6vw]">
                  authN/Z · rate limits · semantic cache · model routing · cost
                  metering
                </span>
              </p>
              <p className="font-body text-accent text-[1.1vw]">
                APIM GenAI Gateway
              </p>
            </div>
            <Arrow />
            {/* 3 Intake + Intent */}
            <div className="grid grid-cols-2 gap-[0.8vw]">
              <div className={`${band} px-[1vw] py-[0.8vh]`}>
                <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                  <Num n="3" />
                  Multimodal Intake
                </p>
                <p className="font-body text-muted text-[1.05vw] leading-snug">
                  docs, voice, video, images —{' '}
                  <span className="text-accent">
                    Document Intelligence · Speech · GPT-4o
                  </span>
                </p>
              </div>
              <div className={`${band} px-[1vw] py-[0.8vh]`}>
                <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                  <Num n="4" />
                  Intent, Priority &amp; Routing
                </p>
                <p className="font-body text-muted text-[1.05vw] leading-snug">
                  classify · SLA priority · route or escalate —{' '}
                  <span className="text-accent">
                    Foundry classifiers · Service Bus
                  </span>
                </p>
              </div>
            </div>
            <Arrow />
            {/* 5 Orchestration plane */}
            <div className={`${cell} px-[1vw] py-[0.8vh] flex-1 min-h-0 flex flex-col`}>
              <div className="flex items-center justify-between">
                <p className="font-display font-bold text-accent text-[1.2vw] flex items-center">
                  <Num n="5" />
                  Agent Orchestration Plane
                </p>
                <p className="font-body text-accent text-[1.15vw]">
                  A2A protocol · Semantic Kernel / Foundry Agent Service
                </p>
              </div>
              <div className="grid grid-cols-5 gap-[0.7vw] mt-[0.7vh] flex-1 min-h-0">
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Supervisor Agent
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    plans, delegates to persona agents, enforces loop budgets
                    (harness engineering)
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Reason
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    fast SLM path for repeat issues · CoT + mixture-of-experts
                    for complex cases
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Memory
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    thread (short-term) · employee &amp; case memory in Cosmos
                    DB · vectors in AI Search
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Human-in-the-Loop
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    approval workbench · confidence thresholds · escalate to HR
                    ops with full context
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    System Watcher
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    polls BGV, ITSM &amp; payroll · vendor webhooks · closes
                    items, flags SLA breaches
                  </p>
                </div>
              </div>
            </div>
            <Arrow />
            {/* 6 Services */}
            <div className="grid grid-cols-3 gap-[0.8vw]">
              <div className={`${cell} px-[0.9vw] py-[0.7vh]`}>
                <p className="font-display font-bold text-accent text-[1.05vw] flex items-center">
                  <Num n="6" />
                  MCP Services + Registry
                </p>
                <p className="font-body text-text text-[1.05vw] leading-snug">
                  tool &amp; agent registry (discovery, versioning, RBAC) ·
                  policy RAG · curated HR knowledge base
                </p>
              </div>
              <div className={`${cell} px-[0.9vw] py-[0.7vh]`}>
                <p className="font-display font-bold text-accent text-[1.15vw] flex items-center">
                  <Num n="6" />
                  Case Management &amp; SLA
                </p>
                <p className="font-body text-text text-[1.05vw] leading-snug">
                  every request = auditable case · status, SLA timers,
                  hand-offs between agents &amp; humans
                </p>
              </div>
              <div className={`${cell} px-[0.9vw] py-[0.7vh]`}>
                <p className="font-display font-bold text-accent text-[1.15vw] flex items-center">
                  <Num n="6" />
                  Act — Integration Layer
                </p>
                <p className="font-body text-text text-[1.05vw] leading-snug">
                  GET / PUT via APIM &amp; Logic Apps connectors ·
                  approval-gated writes · idempotent retries
                </p>
              </div>
            </div>
            <Arrow />
            {/* 7 Systems of record */}
            <div className={`${band} px-[1vw] py-[0.8vh] flex items-center justify-between`}>
              <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                <Num n="7" />
                Systems of Record
              </p>
              <p className="font-body text-accent text-[1.1vw]">
                Workday · SAP SuccessFactors · payroll · benefits · ticketing ·
                HR data stores
              </p>
            </div>
          </div>

          {/* ===== cross-cutting rail ===== */}
          <div className="w-[17vw] flex flex-col gap-[0.7vh] min-h-0">
            <p className="font-body text-muted text-[1.05vw] tracking-[0.18em] uppercase text-center">
              Cross-cutting
            </p>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Identity — humans &amp; agents
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                Entra ID + Entra Agent ID · least-privilege, on-behalf-of ·
                Key Vault
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Guardrails
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                Content Safety · prompt shields · PII redaction · grounding
                checks
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Observability &amp; Evals
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                agent tracing (AgentOps) · continuous evaluation &amp; red
                teaming · Azure Monitor
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Governance &amp; Cost
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                Purview data governance · model lifecycle · token cost / FinOps
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Reporting
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                Microsoft Fabric · Power BI — deflection, SLA, quality, cost
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
