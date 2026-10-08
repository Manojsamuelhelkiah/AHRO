export default function SecurityTrustResponsibleAI() {
  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-bg px-[5vw] py-[5vh]">
      <div className="border-b border-[#24406b] pb-[2.5vh]">
        <p className="font-body text-[1.5vw] font-semibold uppercase tracking-[0.18em] text-accent">Agentic HRO · Implemented safeguards</p>
        <h1 className="mt-[1.3vh] font-display text-[3.8vw] font-bold leading-tight tracking-tight text-text">Security, trust &amp; responsible AI</h1>
        <p className="mt-[1.5vh] font-body text-[2vw] leading-snug text-muted">AI recommends. Live controls and authorized people govern consequential actions.</p>
      </div>

      <div className="my-[2.5vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
        <section className="border border-[#28568c] bg-[#102844] px-[1.7vw] py-[2.6vh]">
          <p className="font-body text-[1.5vw] font-semibold leading-none tracking-[0.15em] text-accent">01 · PROTECT</p>
          <h2 className="mt-[1.2vh] font-display text-[2.6vw] font-bold leading-tight text-text">Security</h2>
          <ul className="mt-[2vh] space-y-[1.6vh] font-body text-[2vw] leading-tight text-text">
            <li>Tenant-isolated records</li>
            <li>Scoped human &amp; agent access</li>
            <li>Private uploads &amp; malware quarantine</li>
            <li>Retention rules &amp; legal holds</li>
          </ul>
        </section>

        <section className="border border-[#294461] bg-[#102038] px-[1.7vw] py-[2.6vh]">
          <p className="font-body text-[1.5vw] font-semibold leading-none tracking-[0.15em] text-accent">02 · VERIFY</p>
          <h2 className="mt-[1.2vh] font-display text-[2.6vw] font-bold leading-tight text-text">Trust</h2>
          <ul className="mt-[2vh] space-y-[1.6vh] font-body text-[2vw] leading-tight text-text">
            <li>Named specialist authority</li>
            <li>Approval &amp; readiness gates</li>
            <li>Tamper-evident audit trail</li>
            <li>Safe retries; uncertain writes stop</li>
          </ul>
        </section>

        <section className="border border-[#357485] bg-[#102c36] px-[1.7vw] py-[2.6vh]">
          <p className="font-body text-[1.5vw] font-semibold leading-none tracking-[0.15em] text-accent">03 · GOVERN</p>
          <h2 className="mt-[1.2vh] font-display text-[2.6vw] font-bold leading-tight text-text">Responsible AI</h2>
          <ul className="mt-[2vh] space-y-[1.6vh] font-body text-[2vw] leading-tight text-text">
            <li>Approved sources &amp; citations</li>
            <li>Evidence-based explanations</li>
            <li>Human oversight of decisions</li>
            <li>AI budgets; metadata-only context</li>
          </ul>
        </section>
      </div>

      <div className="border-t border-[#24406b] pt-[2vh]">
        <p className="font-body text-[1.5vw] leading-snug text-muted">Approved configuration and providers required · Not a compliance certification or bias-free AI guarantee.</p>
      </div>
    </div>
  );
}
