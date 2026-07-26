export default function ExperienceIntake() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[38vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[7vw] py-[8vh]">
        <p className="font-body text-accent text-[1.5vw] font-semibold tracking-[0.22em] uppercase">
          Layer 1 · Meet the Employee
        </p>
        <h2 className="font-display font-bold text-text text-[3.8vw] tracking-tight mt-[1vh]">
          Agentic Experience &amp; Multimodal Intake
        </h2>
        <div className="grid grid-cols-2 gap-[3vw] mt-[5vh] flex-1">
          <div className="bg-[#111f38] rounded-[1vw] p-[2.2vw] flex flex-col">
            <h3 className="font-display font-medium text-primary text-[2.1vw]">
              Experience Layer
            </h3>
            <p className="font-body text-text text-[1.75vw] leading-relaxed mt-[2vh] [text-wrap:pretty]">
              Named AI personas — "Mia" for payroll, "Leo" for onboarding —
              meet employees in Teams, web, email and voice for instant,
              autonomous resolution.
            </p>
            <p className="font-body text-muted text-[1.55vw] leading-relaxed mt-auto pt-[2vh]">
              Azure AI Foundry Agent Service + Copilot Studio orchestrate the
              personas.
            </p>
          </div>
          <div className="bg-[#111f38] rounded-[1vw] p-[2.2vw] flex flex-col">
            <h3 className="font-display font-medium text-primary text-[2.1vw]">
              Multimodal Layer
            </h3>
            <p className="font-body text-text text-[1.75vw] leading-relaxed mt-[2vh] [text-wrap:pretty]">
              Documents, voice files, videos and images flow in through Azure
              AI Document Intelligence, Speech-to-Text, Video Indexer and
              GPT-4o vision.
            </p>
            <p className="font-body text-muted text-[1.55vw] leading-relaxed mt-auto pt-[2vh]">
              Every format becomes structured, actionable input.
            </p>
          </div>
        </div>
        <div className="mt-[4vh] flex items-center gap-[1.5vw] bg-[#0e2440] rounded-[0.8vw] px-[2vw] py-[2.2vh]">
          <span className="font-display font-bold text-accent text-[1.6vw] shrink-0">
            Example
          </span>
          <p className="font-body text-text text-[1.6vw] leading-snug [text-wrap:pretty]">
            An employee uploads a photographed marriage certificate plus a
            voice note — the platform reads both and triggers a life-event
            benefits change.
          </p>
        </div>
      </div>
    </div>
  );
}
