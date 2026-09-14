import { Slide21 } from '../../components/BusinessDeck';

export default Slide21;

export function LegacyInsightImpact() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[94vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[7vw] py-[8vh]">
        <p className="font-body text-accent text-[1.5vw] font-semibold tracking-[0.22em] uppercase">
          Layer 5 · Insight &amp; Impact
        </p>
        <h2 className="font-display font-bold text-text text-[3.8vw] tracking-tight mt-[1vh]">
          Reporting, Dashboards &amp; the Road Ahead
        </h2>
        <div className="flex gap-[4vw] mt-[5vh] items-start">
          <div className="shrink-0">
            <p className="font-display font-bold text-primary text-[8vw] leading-none tracking-tight">
              70–80%
            </p>
            <p className="font-body text-muted text-[1.6vw] mt-[1vh] max-w-[24vw] [text-wrap:pretty]">
              of routine HRO intents resolved autonomously — minutes, not days
              (illustrative targets)
            </p>
          </div>
          <div className="flex-1 flex flex-col gap-[2.5vh] pt-[1vh]">
            <p className="font-body text-text text-[1.75vw] leading-relaxed [text-wrap:pretty]">
              Microsoft Fabric + Power BI dashboards track resolution rates,
              autonomy share, CSAT, cost per case and human-in-loop
              interventions.
            </p>
            <p className="font-body text-text text-[1.75vw] leading-relaxed [text-wrap:pretty]">
              MCP and A2A open standards mean new agents, tools and vendors
              plug in without re-architecture.
            </p>
          </div>
        </div>
        <div className="mt-auto bg-[#0e2440] rounded-[0.8vw] px-[2vw] py-[2.5vh]">
          <p className="font-display font-medium text-accent text-[1.9vw]">
            Start with 2–3 high-volume intents. Measure. Then scale the agent
            mesh across the full hire-to-retire cycle.
          </p>
        </div>
      </div>
    </div>
  );
}
