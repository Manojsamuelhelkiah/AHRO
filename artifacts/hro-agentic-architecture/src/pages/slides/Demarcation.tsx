const LAYERS = [
  {
    tag: "Core Product",
    color: "#34d399",
    bg: "#0d2b22",
    share: "One platform, every client",
    body: "The shipped platform — experience gateway, intent router, agent orchestration, MCP integration layer, RAG pipeline, HITL console, guardrails & audit trail. Engineered once, amortized across all clients, upgraded centrally.",
    examples: "AI gateway · orchestrator · System Watcher · audit trail",
  },
  {
    tag: "Configurable",
    color: "#38bdf8",
    bg: "#0c2338",
    share: "Dials, not code",
    body: "What each client tunes per tenant and per scenario without any engineering: model stack per role, isolation tier, containment & HITL sampling rates, adoption ramp, hourly rates, escalation & alert policies.",
    examples: "model selection · isolation tier · HITL rates · alert emails",
  },
  {
    tag: "Custom",
    color: "#fbbf24",
    bg: "#332714",
    share: "Per-client effort, priced individually",
    body: "Client-specific engineering and content: connectors into their system landscape, country policy packs and localization, bespoke flows, onboarding setup — plus ongoing per-country knowledge maintenance.",
    examples: "system connectors · country packs · bespoke flows · onboarding",
  },
];

export default function Demarcation() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[80vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[7vw] py-[8vh]">
        <p className="font-body text-accent text-[1.5vw] font-semibold tracking-[0.22em] uppercase">
          Productization · Demarcation
        </p>
        <h2 className="font-display font-bold text-text text-[3.8vw] tracking-tight mt-[1vh]">
          Core vs Configurable vs Custom
        </h2>
        <p className="font-body text-text/70 text-[1.6vw] mt-[1vh] [text-wrap:pretty]">
          Every cost line in the business case carries this demarcation — so pricing, roadmap
          ownership and client conversations stay unambiguous.
        </p>
        <div className="grid grid-cols-3 gap-[2vw] mt-[4vh] flex-1">
          {LAYERS.map((l) => (
            <div key={l.tag} className="rounded-[1vw] p-[1.8vw] flex flex-col" style={{ backgroundColor: l.bg }}>
              <p className="font-display font-bold text-[1.5vw] tracking-[0.15em] uppercase" style={{ color: l.color }}>
                {l.tag}
              </p>
              <p className="font-body font-semibold text-text text-[1.4vw] mt-[0.6vh]">{l.share}</p>
              <p className="font-body text-text text-[1.45vw] leading-relaxed mt-[1.5vh] [text-wrap:pretty]">
                {l.body}
              </p>
              <p className="font-body text-[1.2vw] mt-auto pt-[2vh]" style={{ color: l.color }}>
                {l.examples}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-[3.5vh] flex items-center gap-[1.5vw] bg-[#0e2440] rounded-[0.8vw] px-[2vw] py-[2vh]">
          <span className="font-display font-bold text-accent text-[1.6vw] shrink-0">Rule</span>
          <p className="font-body text-text text-[1.5vw] leading-snug [text-wrap:pretty]">
            Custom work never forks the core: client-specific connectors and content plug in at
            defined extension points, so every tenant stays on the same upgradeable platform.
          </p>
        </div>
      </div>
    </div>
  );
}
