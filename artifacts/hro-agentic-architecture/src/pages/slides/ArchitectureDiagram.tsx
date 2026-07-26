export default function ArchitectureDiagram() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute inset-0 flex flex-col px-[4.5vw] py-[5vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.9vw] tracking-tight">
            Reference Architecture — One View
          </h2>
          <p className="font-body text-muted text-[1.5vw]">
            Azure &amp; Microsoft stack · MCP + A2A native
          </p>
        </div>
        <div className="flex gap-[1.5vw] mt-[2.5vh] flex-1 min-h-0">
          <div className="flex-1 flex flex-col gap-[1vh] min-h-0">
            <div className="bg-[#12233f] border border-[#24406b] rounded-[0.6vw] px-[1.4vw] py-[1.2vh] flex items-center justify-between">
              <p className="font-display font-bold text-text text-[1.6vw]">
                Experience Layer
                <span className="font-body font-normal text-muted text-[1.5vw]">
                  {' '}
                  — AI personas in Teams, web, email, voice
                </span>
              </p>
              <p className="font-body text-accent text-[1.5vw]">
                Copilot Studio · AI Foundry Agents
              </p>
            </div>
            <div className="bg-[#12233f] border border-[#24406b] rounded-[0.6vw] px-[1.4vw] py-[1.2vh] flex items-center justify-between">
              <p className="font-display font-bold text-text text-[1.6vw]">
                Multimodal Intake
                <span className="font-body font-normal text-muted text-[1.5vw]">
                  {' '}
                  — documents, voice, video, images
                </span>
              </p>
              <p className="font-body text-accent text-[1.5vw]">
                Document Intelligence · Speech · Video Indexer · GPT-4o
              </p>
            </div>
            <div className="bg-[#12233f] border border-[#24406b] rounded-[0.6vw] px-[1.4vw] py-[1.2vh] flex items-center justify-between">
              <p className="font-display font-bold text-text text-[1.6vw]">
                Intent Classification &amp; Routing
                <span className="font-body font-normal text-muted text-[1.5vw]">
                  {' '}
                  — classify, prioritize, route
                </span>
              </p>
              <p className="font-body text-accent text-[1.5vw]">
                AI Foundry classifiers · Service Bus
              </p>
            </div>
            <div className="bg-[#12233f] border border-[#24406b] rounded-[0.6vw] px-[1.4vw] py-[1.2vh] flex items-center justify-between">
              <p className="font-display font-bold text-text text-[1.6vw]">
                Agent Orchestration
                <span className="font-body font-normal text-muted text-[1.5vw]">
                  {' '}
                  — A2A multi-agent loops · human-in-the-loop · harness
                  engineering
                </span>
              </p>
              <p className="font-body text-accent text-[1.5vw]">
                A2A protocol · AgentOps
              </p>
            </div>
            <div className="grid grid-cols-3 gap-[1vw] flex-1 min-h-0">
              <div className="bg-[#0f2a47] border border-[#2f5c94] rounded-[0.6vw] px-[1.2vw] py-[1.2vh]">
                <p className="font-display font-bold text-accent text-[1.5vw]">
                  Services (MCP)
                </p>
                <p className="font-body text-text text-[1.5vw] leading-snug mt-[0.8vh]">
                  Tools, prompts, resources · policy RAG on AI Search ·
                  read-only knowledge &amp; storage DBs
                </p>
              </div>
              <div className="bg-[#0f2a47] border border-[#2f5c94] rounded-[0.6vw] px-[1.2vw] py-[1.2vh]">
                <p className="font-display font-bold text-accent text-[1.5vw]">
                  Reason
                </p>
                <p className="font-body text-text text-[1.5vw] leading-snug mt-[0.8vh]">
                  Fast path for repeat issues · chain-of-thought &amp;
                  mixture-of-experts for complex cases
                </p>
              </div>
              <div className="bg-[#0f2a47] border border-[#2f5c94] rounded-[0.6vw] px-[1.2vw] py-[1.2vh]">
                <p className="font-display font-bold text-accent text-[1.5vw]">
                  Act
                </p>
                <p className="font-body text-text text-[1.5vw] leading-snug mt-[0.8vh]">
                  GET / PUT via API Management &amp; Logic Apps · approval-gated
                  writes
                </p>
              </div>
            </div>
            <div className="bg-[#12233f] border border-[#24406b] rounded-[0.6vw] px-[1.4vw] py-[1.2vh] flex items-center justify-between">
              <p className="font-display font-bold text-text text-[1.6vw]">
                Systems of Record
              </p>
              <p className="font-body text-accent text-[1.5vw]">
                Workday · SAP SuccessFactors · payroll · ticketing · HR data
                stores
              </p>
            </div>
          </div>
          <div className="w-[16vw] flex flex-col gap-[1vh]">
            <p className="font-body text-muted text-[1.5vw] tracking-[0.18em] uppercase text-center">
              Cross-cutting
            </p>
            <div className="flex-1 bg-[#16273f] border border-[#2a4568] rounded-[0.6vw] px-[1vw] py-[1.2vh]">
              <p className="font-display font-bold text-text text-[1.5vw]">
                Security
              </p>
              <p className="font-body text-muted text-[1.5vw] leading-snug mt-[0.5vh]">
                Entra ID · Key Vault · Purview
              </p>
            </div>
            <div className="flex-1 bg-[#16273f] border border-[#2a4568] rounded-[0.6vw] px-[1vw] py-[1.2vh]">
              <p className="font-display font-bold text-text text-[1.5vw]">
                Guardrails
              </p>
              <p className="font-body text-muted text-[1.5vw] leading-snug mt-[0.5vh]">
                Content Safety · prompt shields · PII redaction
              </p>
            </div>
            <div className="flex-1 bg-[#16273f] border border-[#2a4568] rounded-[0.6vw] px-[1vw] py-[1.2vh]">
              <p className="font-display font-bold text-text text-[1.5vw]">
                Observability
              </p>
              <p className="font-body text-muted text-[1.5vw] leading-snug mt-[0.5vh]">
                Azure Monitor · App Insights · agent tracing
              </p>
            </div>
            <div className="flex-1 bg-[#16273f] border border-[#2a4568] rounded-[0.6vw] px-[1vw] py-[1.2vh]">
              <p className="font-display font-bold text-text text-[1.5vw]">
                Reporting
              </p>
              <p className="font-body text-muted text-[1.5vw] leading-snug mt-[0.5vh]">
                Microsoft Fabric · Power BI
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
