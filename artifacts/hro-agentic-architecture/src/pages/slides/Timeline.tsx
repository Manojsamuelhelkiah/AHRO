type Task = {
  name: string;
  start: number; // week (0-based)
  len: number; // weeks
  color: string;
  note?: string;
};

const TOTAL = 26;

const phases: { phase: string; tasks: Task[] }[] = [
  {
    phase: 'Discover',
    tasks: [
      { name: 'Discovery: intents, volumes, policies, systems', start: 0, len: 4, color: '#7ac9f5' },
      { name: 'Solution design & isolation-tier decision', start: 2, len: 3, color: '#7ac9f5' },
    ],
  },
  {
    phase: 'Foundation',
    tasks: [
      { name: 'Landing zone, network, identity & security', start: 3, len: 5, color: '#8fd6a8' },
      { name: 'HCM / payroll / ticketing connectors', start: 5, len: 7, color: '#8fd6a8' },
      { name: 'Policy library import & knowledge indexing', start: 6, len: 5, color: '#8fd6a8' },
    ],
  },
  {
    phase: 'Build',
    tasks: [
      { name: 'Deterministic flows (payslip, leave, letters)', start: 8, len: 5, color: '#d9b36a' },
      { name: 'Knowledge & policy Q&A flows', start: 10, len: 4, color: '#d9b36a' },
      { name: 'Multi-agent cases + HITL workbench', start: 12, len: 5, color: '#d9b36a' },
    ],
  },
  {
    phase: 'Assure',
    tasks: [
      { name: 'Evals, red teaming & guardrail tuning', start: 14, len: 5, color: '#e08a8a' },
      { name: 'Client UAT in tenant sandbox', start: 17, len: 3, color: '#e08a8a' },
    ],
  },
  {
    phase: 'Launch',
    tasks: [
      { name: 'Pilot wave — one country / population', start: 19, len: 3, color: '#b28af5' as string, note: 'go/no-go' },
      { name: 'Scale rollout + hypercare', start: 21, len: 5, color: '#b28af5' },
    ],
  },
];

const milestones = [
  { week: 4, label: 'Design signed off' },
  { week: 12, label: 'Connectors live' },
  { week: 19, label: 'UAT exit' },
  { week: 22, label: 'Pilot go-live' },
  { week: 26, label: 'Full rollout' },
];

import { Slide19 } from '../../components/BusinessDeck';

export default Slide19;

export function LegacyTimeline() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[100vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3.2vw] py-[3.2vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Implementation Plan — ~26 Weeks to Full Rollout
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            per client onboarding · phases overlap deliberately
          </p>
        </div>

        {/* week scale */}
        <div className="flex mt-[1.4vh] ml-[24vw]">
          {[0, 4, 8, 12, 16, 20, 24].map((w) => (
            <div key={w} style={{ width: `${(4 / TOTAL) * 69}vw` }}>
              <p className="font-body text-muted text-[0.9vw]">W{w}</p>
            </div>
          ))}
        </div>

        <div className="flex-1 min-h-0 flex flex-col gap-[0.5vh] mt-[0.3vh]">
          {phases.map((p) => (
            <div key={p.phase} className="flex-1 flex flex-col justify-center gap-[0.4vh] border-t border-[#1c3050] pt-[0.4vh]">
              {p.tasks.map((t) => (
                <div key={t.name} className="flex items-center h-[3.2vh]">
                  <p className="w-[5vw] shrink-0 font-display font-bold text-muted text-[0.95vw] uppercase tracking-wide">
                    {t === p.tasks[0] ? p.phase : ''}
                  </p>
                  <p className="w-[19vw] shrink-0 font-body text-text text-[1vw] leading-tight pr-[0.8vw]">
                    {t.name}
                  </p>
                  <div className="relative flex-1 h-full">
                    {/* grid lines */}
                    {[4, 8, 12, 16, 20, 24].map((w) => (
                      <div
                        key={w}
                        className="absolute top-0 bottom-0 w-px bg-[#1c3050]"
                        style={{ left: `${(w / TOTAL) * 100}%` }}
                      />
                    ))}
                    <div
                      className="absolute top-[15%] bottom-[15%] rounded-full"
                      style={{
                        left: `${(t.start / TOTAL) * 100}%`,
                        width: `${(t.len / TOTAL) * 100}%`,
                        backgroundColor: t.color,
                        opacity: 0.85,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* milestones */}
          <div className="flex items-center h-[5vh] border-t border-[#1c3050] pt-[0.4vh]">
            <p className="w-[5vw] shrink-0 font-display font-bold text-accent text-[0.95vw] uppercase tracking-wide">
              Gates
            </p>
            <p className="w-[19vw] shrink-0 font-body text-muted text-[1vw]">
              Milestones &amp; go/no-go gates
            </p>
            <div className="relative flex-1 h-full">
              {milestones.map((m) => (
                <div
                  key={m.label}
                  className="absolute top-0 flex flex-col items-center"
                  style={{ left: `${(m.week / TOTAL) * 100}%`, transform: 'translateX(-50%)' }}
                >
                  <div className="w-[0.9vw] h-[0.9vw] rotate-45 bg-accent" />
                  <p className="font-body text-accent text-[0.85vw] whitespace-nowrap mt-[0.3vh]">
                    {m.label}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <p className="font-body text-muted text-[1vw] text-right mt-[0.5vh]">
          Team: solution architect · agent engineers ×3 · integration engineers ×2 · HR
          process lead · security engineer · client-side SMEs — subsequent clients
          compress to ~10–14 weeks via the onboarding factory
        </p>
      </div>
    </div>
  );
}
