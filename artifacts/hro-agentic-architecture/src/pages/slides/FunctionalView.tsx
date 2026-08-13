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

export default function FunctionalView() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute inset-0 flex flex-col px-[3.2vw] py-[3.2vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Functional View — What Each Part Does
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            Same numbers as the technical view — ① here is ① there
          </p>
        </div>

        <div className="flex gap-[1.1vw] mt-[1.6vh] flex-1 min-h-0">
          <div className="flex-1 flex flex-col min-h-0 gap-[0.7vh]">
            <div className={`${band} px-[1vw] py-[0.8vh] flex items-center justify-between`}>
              <p className="font-display font-bold text-text text-[1.15vw] flex items-center min-w-0">
                <Num n="1" />
                Employee &amp; Manager Front Door
                <span className="font-body font-normal text-muted text-[1.1vw] ml-[0.6vw]">
                  one HR assistant wherever people work — chat, portal, email,
                  phone
                </span>
              </p>
              <p className="font-body text-accent text-[1.1vw] shrink-0 ml-[0.8vw]">
                also reaches out first: onboarding, moves, exits
              </p>
            </div>
            <Arrow />
            <div className={`${band} px-[1vw] py-[0.8vh] flex items-center justify-between`}>
              <p className="font-display font-bold text-text text-[1.15vw] flex items-center min-w-0">
                <Num n="2" />
                Reception &amp; Traffic Control
                <span className="font-body font-normal text-muted text-[1.1vw] ml-[0.6vw]">
                  checks who is asking · keeps usage fair · tracks cost of every
                  answer
                </span>
              </p>
            </div>
            <Arrow />
            <div className="grid grid-cols-2 gap-[0.8vw]">
              <div className={`${band} px-[1vw] py-[0.8vh]`}>
                <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                  <Num n="3" />
                  Understands Any Format
                </p>
                <p className="font-body text-muted text-[1.05vw] leading-snug">
                  reads payslips, contracts, forms, ID scans · listens to
                  voicemails · watches screen recordings
                </p>
              </div>
              <div className={`${band} px-[1vw] py-[0.8vh]`}>
                <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                  <Num n="4" />
                  Triage Desk
                </p>
                <p className="font-body text-muted text-[1.05vw] leading-snug">
                  works out what is being asked · how urgent it is · who (or
                  what) should handle it
                </p>
              </div>
            </div>
            <Arrow />
            <div className={`${cell} px-[1vw] py-[0.8vh] flex-1 min-h-0 flex flex-col`}>
              <div className="flex items-center justify-between">
                <p className="font-display font-bold text-accent text-[1.2vw] flex items-center">
                  <Num n="5" />
                  Digital HR Case Team
                </p>
                <p className="font-body text-accent text-[1.05vw]">
                  works like a real HR team — a lead, specialists, and an
                  escalation path
                </p>
              </div>
              <div className="grid grid-cols-5 gap-[0.7vw] mt-[0.7vh] flex-1 min-h-0">
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Case Lead
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    owns the request end-to-end · splits work across specialist
                    personas · stops runaway work
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Judgment
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    routine requests: instant playbook · complex cases: careful
                    step-by-step reasoning
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Remembers You
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    knows the conversation so far · your history, country,
                    grade, open cases
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Asks a Human
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    unsure or sensitive? hands the case to HR ops with the full
                    story attached
                  </p>
                </div>
                <div className="bg-[#12233f]/80 border border-[#24406b] rounded-[0.4vw] px-[0.7vw] py-[0.6vh]">
                  <p className="font-display font-bold text-text text-[1.1vw]">
                    Keeps Watch
                  </p>
                  <p className="font-body text-muted text-[1.05vw] leading-snug">
                    chases background checks, IT tickets &amp; payroll · closes
                    items itself · raises overdue flags
                  </p>
                </div>
              </div>
            </div>
            <Arrow />
            <div className="grid grid-cols-3 gap-[0.8vw]">
              <div className={`${cell} px-[0.9vw] py-[0.7vh]`}>
                <p className="font-display font-bold text-accent text-[1.15vw] flex items-center">
                  <Num n="6" />
                  HR Policy Library &amp; Toolbox
                </p>
                <p className="font-body text-text text-[1.05vw] leading-snug">
                  the HR policy database (per country, always current) · a
                  catalog of approved actions agents may take
                </p>
              </div>
              <div className={`${cell} px-[0.9vw] py-[0.7vh]`}>
                <p className="font-display font-bold text-accent text-[1.15vw] flex items-center">
                  <Num n="6" />
                  Case File &amp; SLA Clock
                </p>
                <p className="font-body text-text text-[1.05vw] leading-snug">
                  every request becomes a tracked case — who did what, when,
                  and is it still on time
                </p>
              </div>
              <div className={`${cell} px-[0.9vw] py-[0.7vh]`}>
                <p className="font-display font-bold text-accent text-[1.15vw] flex items-center">
                  <Num n="6" />
                  Execution Desk
                </p>
                <p className="font-body text-text text-[1.05vw] leading-snug">
                  actually makes the change — updates records, triggers payroll
                  — with approval where required
                </p>
              </div>
            </div>
            <Arrow />
            <div className={`${band} px-[1vw] py-[0.8vh] flex items-center justify-between`}>
              <p className="font-display font-bold text-text text-[1.15vw] flex items-center">
                <Num n="7" />
                Where HR Data Lives
              </p>
              <p className="font-body text-accent text-[1.1vw]">
                HR record system · payroll · benefits · ticketing — unchanged,
                just connected
              </p>
            </div>
          </div>

          <div className="w-[17vw] flex flex-col gap-[0.7vh] min-h-0">
            <p className="font-body text-muted text-[1.05vw] tracking-[0.18em] uppercase text-center">
              Always On
            </p>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Access Badges
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                people and agents only see what their role allows
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Safety Net
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                blocks unsafe content · hides personal data · keeps answers on
                policy
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Quality Control
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                every agent answer is logged, sampled and scored — like call QA
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Oversight
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                data handling rules, audit trail, and cost per case under
                control
              </p>
            </div>
            <div className={`${rail} flex-1 px-[0.8vw] py-[0.7vh]`}>
              <p className="font-display font-bold text-text text-[1.15vw]">
                Dashboards
              </p>
              <p className="font-body text-muted text-[1.05vw] leading-snug">
                self-service rate, speed, satisfaction, cost — live for HR
                leadership
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
