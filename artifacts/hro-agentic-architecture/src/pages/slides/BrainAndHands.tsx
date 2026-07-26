export default function BrainAndHands() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[66vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[7vw] py-[8vh]">
        <p className="font-body text-accent text-[1.5vw] font-semibold tracking-[0.22em] uppercase">
          Layer 3 · The Agent's Brain and Hands
        </p>
        <h2 className="font-display font-bold text-text text-[3.8vw] tracking-tight mt-[1vh]">
          Services, Reasoning &amp; Action
        </h2>
        <div className="grid grid-cols-3 gap-[2vw] mt-[5vh] flex-1">
          <div className="bg-[#111f38] rounded-[1vw] p-[1.8vw] flex flex-col">
            <p className="font-display font-bold text-accent text-[1.4vw] tracking-[0.15em] uppercase">
              Services · MCP
            </p>
            <p className="font-body text-text text-[1.6vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
              Tools, resources and prompts managed via Model Context Protocol
              servers — policy RAG on Azure AI Search, read-only access to HR
              knowledge and storage databases.
            </p>
          </div>
          <div className="bg-[#111f38] rounded-[1vw] p-[1.8vw] flex flex-col">
            <p className="font-display font-bold text-accent text-[1.4vw] tracking-[0.15em] uppercase">
              Reason
            </p>
            <p className="font-body text-text text-[1.6vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
              Fast-path reasoning for repeat issues; deep chain-of-thought and
              mixture-of-experts (o-series models) for novel, complex cases.
            </p>
          </div>
          <div className="bg-[#111f38] rounded-[1vw] p-[1.8vw] flex flex-col">
            <p className="font-display font-bold text-accent text-[1.4vw] tracking-[0.15em] uppercase">
              Act
            </p>
            <p className="font-body text-text text-[1.6vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
              GET / PUT connectors into systems of record — Workday, SAP
              SuccessFactors, payroll engines, ticketing — via Azure API
              Management, Logic Apps and MCP tool calls.
            </p>
          </div>
        </div>
        <div className="mt-[4vh] flex items-center gap-[1.5vw] bg-[#0e2440] rounded-[0.8vw] px-[2vw] py-[2.2vh]">
          <span className="font-display font-bold text-accent text-[1.6vw] shrink-0">
            Example
          </span>
          <p className="font-body text-text text-[1.55vw] leading-snug [text-wrap:pretty]">
            "How many leave days do I have?" → instant RAG answer. "Relocation
            + tax + visa" → deep-reasoning agent drafts a full case and writes
            it back to the HCM.
          </p>
        </div>
      </div>
    </div>
  );
}
