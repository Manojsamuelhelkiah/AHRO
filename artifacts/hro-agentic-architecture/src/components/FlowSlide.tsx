type Step = { label: string; refs?: string; human?: boolean };

export type FlowSlideProps = {
  kicker: string;
  title: string;
  tags: string[];
  asIsSteps: string[];
  asIsPain: string;
  toBeSteps: Step[];
  outcome: string;
};

function Chip({ step }: { step: Step }) {
  return (
    <div
      className={`rounded-[0.5vw] px-[0.9vw] py-[0.9vh] border ${
        step.human
          ? 'bg-[#3a2a14] border-[#8a6a2f]'
          : 'bg-[#0f2a47] border-[#2f5c94]'
      }`}
    >
      <p className="font-body text-text text-[1.15vw] leading-snug max-w-[38vw]">
        {step.label}
        {step.refs && (
          <span className="text-accent font-display font-bold ml-[0.4vw]">
            {step.refs}
          </span>
        )}
      </p>
    </div>
  );
}

export default function FlowSlide({
  kicker,
  title,
  tags,
  asIsSteps,
  asIsPain,
  toBeSteps,
  outcome,
}: FlowSlideProps) {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[90vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[4.5vw] py-[5vh]">
        <div className="flex items-center justify-between gap-[1vw]">
          <div className="min-w-0">
            <p className="font-body text-accent text-[1.2vw] font-semibold tracking-[0.22em] uppercase">
              {kicker}
            </p>
            <h2 className="font-display font-bold text-text text-[2.6vw] tracking-tight mt-[0.4vh]">
              {title}
            </h2>
          </div>
          <div className="flex flex-wrap justify-end gap-[0.6vw] max-w-[34vw] shrink-0">
            {tags.map((t) => (
              <span
                key={t}
                className="font-body text-accent text-[1.05vw] border border-[#2f5c94] rounded-full px-[1vw] py-[0.5vh] whitespace-nowrap"
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex flex-col justify-center gap-[3vh] mt-[2vh]">
          {/* AS-IS */}
          <div className="bg-[#141b29] border border-[#30405c] rounded-[0.7vw] px-[1.4vw] py-[1.6vh]">
            <div className="flex items-center gap-[1vw]">
              <p className="font-display font-bold text-muted text-[1.3vw] tracking-[0.15em] uppercase shrink-0 w-[9vw]">
                As-Is
              </p>
              <div className="flex items-center flex-wrap gap-y-[0.8vh]">
                {asIsSteps.map((s, i) => (
                  <div key={i} className="flex items-center">
                    <div className="bg-[#1b2536] border border-[#39485f] rounded-[0.5vw] px-[0.9vw] py-[0.9vh]">
                      <p className="font-body text-muted text-[1.15vw] leading-snug">
                        {s}
                      </p>
                    </div>
                    {i < asIsSteps.length - 1 && (
                      <span className="text-[#54657f] text-[1.2vw] mx-[0.5vw]">
                        →
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <p className="font-body text-[#e08a8a] text-[1.15vw] mt-[1vh] ml-[10vw]">
              {asIsPain}
            </p>
          </div>

          {/* TO-BE */}
          <div className="bg-[#0e2440] border border-[#2f5c94] rounded-[0.7vw] px-[1.4vw] py-[1.6vh]">
            <div className="flex items-center gap-[1vw]">
              <p className="font-display font-bold text-accent text-[1.3vw] tracking-[0.15em] uppercase shrink-0 w-[9vw]">
                To-Be
              </p>
              <div className="flex items-center flex-wrap gap-y-[0.8vh]">
                {toBeSteps.map((s, i) => (
                  <div key={i} className="flex items-center">
                    <Chip step={s} />
                    {i < toBeSteps.length - 1 && (
                      <span className="text-[#3d6db3] text-[1.2vw] mx-[0.5vw]">
                        →
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <p className="font-body text-[#7ee0a3] text-[1.15vw] mt-[1vh] ml-[10vw]">
              {outcome}
            </p>
          </div>
        </div>

        <p className="font-body text-muted text-[1.05vw] text-right">
          ①–⑦ = component on the architecture slides ·{' '}
          <span className="text-[#d9b36a]">amber = human in the loop</span>
        </p>
      </div>
    </div>
  );
}
