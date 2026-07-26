export default function TrustFabric() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[80vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[7vw] py-[8vh]">
        <p className="font-body text-accent text-[1.5vw] font-semibold tracking-[0.22em] uppercase">
          Layer 4 · Trust Fabric
        </p>
        <h2 className="font-display font-bold text-text text-[3.8vw] tracking-tight mt-[1vh]">
          Security, Guardrails &amp; Observability
        </h2>
        <div className="grid grid-cols-3 gap-[2vw] mt-[5vh] flex-1">
          <div className="bg-[#111f38] rounded-[1vw] p-[1.8vw]">
            <p className="font-display font-bold text-accent text-[1.4vw] tracking-[0.15em] uppercase">
              Security
            </p>
            <p className="font-body text-text text-[1.6vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
              Microsoft Entra ID agent identities and RBAC, Key Vault, Purview
              data governance, private networking — every agent acts under
              least privilege.
            </p>
          </div>
          <div className="bg-[#111f38] rounded-[1vw] p-[1.8vw]">
            <p className="font-display font-bold text-accent text-[1.4vw] tracking-[0.15em] uppercase">
              Guardrails
            </p>
            <p className="font-body text-text text-[1.6vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
              Azure AI Content Safety, prompt shields, PII redaction and
              policy-bound actions — writes always gated by human approval
              where required.
            </p>
          </div>
          <div className="bg-[#111f38] rounded-[1vw] p-[1.8vw]">
            <p className="font-display font-bold text-accent text-[1.4vw] tracking-[0.15em] uppercase">
              Observability
            </p>
            <p className="font-body text-text text-[1.6vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
              End-to-end tracing of every agent step in Azure Monitor and
              Application Insights; AgentOps evaluation and drift detection in
              AI Foundry.
            </p>
          </div>
        </div>
        <div className="mt-[4vh] flex items-center gap-[1.5vw] bg-[#0e2440] rounded-[0.8vw] px-[2vw] py-[2.2vh]">
          <span className="font-display font-bold text-accent text-[1.6vw] shrink-0">
            Example
          </span>
          <p className="font-body text-text text-[1.6vw] leading-snug [text-wrap:pretty]">
            An agent attempting to read salary data outside its scope is
            blocked, logged, and flagged to the security dashboard in real
            time.
          </p>
        </div>
      </div>
    </div>
  );
}
