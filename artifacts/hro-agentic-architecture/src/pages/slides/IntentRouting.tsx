export default function IntentRouting() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[52vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[7vw] py-[8vh]">
        <p className="font-body text-accent text-[1.5vw] font-semibold tracking-[0.22em] uppercase">
          Layer 2 · Understand &amp; Converse
        </p>
        <h2 className="font-display font-bold text-text text-[3.8vw] tracking-tight mt-[1vh]">
          Intent Classification, Routing &amp; Multi-Loop Conversations
        </h2>
        <div className="grid grid-cols-2 gap-x-[3vw] gap-y-[3vh] mt-[5vh]">
          <div>
            <h3 className="font-display font-medium text-primary text-[1.9vw]">
              Intent Layer
            </h3>
            <p className="font-body text-text text-[1.65vw] leading-relaxed mt-[1vh] [text-wrap:pretty]">
              Classifies every request against the HRO intent catalog — payroll,
              leave, benefits, letters, exits — then prioritizes and routes via
              Azure AI Foundry classifiers and Service Bus.
            </p>
          </div>
          <div>
            <h3 className="font-display font-medium text-primary text-[1.9vw]">
              Communication Layer
            </h3>
            <p className="font-body text-text text-[1.65vw] leading-relaxed mt-[1vh] [text-wrap:pretty]">
              Multi-agent, multi-loop conversations over the A2A
              (agent-to-agent) protocol, with human-in-the-loop checkpoints for
              approvals and escalations.
            </p>
          </div>
          <div className="col-span-2">
            <h3 className="font-display font-medium text-primary text-[1.9vw]">
              Loop &amp; Harness Engineering
            </h3>
            <p className="font-body text-text text-[1.65vw] leading-relaxed mt-[1vh] [text-wrap:pretty]">
              Bounded agent loops, retry budgets and evaluation harnesses keep
              conversations convergent — never runaway.
            </p>
          </div>
        </div>
        <div className="mt-auto flex items-center gap-[1.5vw] bg-[#0e2440] rounded-[0.8vw] px-[2vw] py-[2.2vh]">
          <span className="font-display font-bold text-accent text-[1.6vw] shrink-0">
            Example
          </span>
          <p className="font-body text-text text-[1.6vw] leading-snug [text-wrap:pretty]">
            "My bonus looks wrong" → payroll dispute, priority high → Payroll
            Agent loops with Compliance Agent, then asks the HR manager to
            approve the correction.
          </p>
        </div>
      </div>
    </div>
  );
}
