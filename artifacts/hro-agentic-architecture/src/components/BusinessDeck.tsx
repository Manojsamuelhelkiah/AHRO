import type { ReactNode } from 'react';

const base = import.meta.env.BASE_URL;

function Header({ section, title, note }: { section: string; title: string; note?: string }) {
  return (
    <div className="flex items-end justify-between border-b border-[#24406b] pb-[2vh]">
      <div>
        <p className="font-body text-accent text-[1.5vw] font-semibold uppercase tracking-[0.2em]">{section}</p>
        <h2 className="mt-[1vh] font-display text-[3.6vw] font-bold leading-none tracking-tight text-text [text-wrap:balance]">{title}</h2>
      </div>
      {note ? <p className="max-w-[25vw] text-right font-body text-[1.5vw] leading-snug text-muted">{note}</p> : null}
    </div>
  );
}

function Footer({ value = "Product perspective · 14 September 2026" }: { value?: string }) {
  return <p className="mt-auto pt-[2vh] font-body text-[1.5vw] text-muted">{value}</p>;
}

function Card({ title, children, tone = "blue" }: { title: string; children: ReactNode; tone?: "blue" | "amber" | "slate" }) {
  const palette = tone === "amber" ? "border-[#9a6c25] bg-[#2a2418]" : tone === "slate" ? "border-[#294461] bg-[#102038]" : "border-[#28568c] bg-[#102844]";
  return (
    <div className={`h-full border ${palette} px-[1.7vw] py-[2vh]`}>
      <h3 className="font-display text-[2.1vw] font-bold leading-tight text-text">{title}</h3>
      <div className="mt-[1.2vh] font-body text-[2vw] leading-snug text-muted">{children}</div>
    </div>
  );
}

export function Slide01() {
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg">
      <img src={`${base}hero-agent-mesh.png`} crossOrigin="anonymous" alt="Connected HR operations" className="absolute inset-0 h-full w-full object-cover opacity-70" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0a1526] via-[#0a1526]/90 to-[#0a1526]/40" />
      <div className="absolute inset-0 flex flex-col justify-center px-[8vw]">
        <p className="font-body text-[1.6vw] font-semibold uppercase tracking-[0.25em] text-accent">Business architecture · 14 September 2026</p>
        <h1 className="mt-[2vh] max-w-[65vw] font-display text-[6.2vw] font-bold leading-[0.98] tracking-tight text-text [text-wrap:balance]">HR operations, connected around accountable cases</h1>
        <p className="mt-[3vh] max-w-[54vw] font-body text-[2.35vw] leading-snug text-muted">A business-led operating model for onboarding, workforce services and governed human decisions.</p>
        <div className="mt-[6vh] flex items-center gap-[1vw]">
          <div className="h-[0.5vh] w-[11vw] bg-primary" /><div className="h-[0.5vh] w-[4vw] bg-accent" /><div className="h-[0.5vh] w-[2vw] bg-[#8aa3c2]" />
        </div>
      </div>
    </div>
  );
}

export function Slide02() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[7vw] py-[7vh]">
    <Header section="Executive decision" title="Approve a governed HR service rollout" note="Start with visible work, named owners and evidence—not autonomous provider changes." />
    <div className="my-[5vh] grid flex-1 grid-cols-[1.2fr_0.8fr] gap-[3vw]">
      <div className="border border-[#28568c] bg-[#102844] p-[3vw]">
        <p className="font-display text-[4.5vw] font-bold leading-tight text-text">Decision requested</p>
        <p className="mt-[2vh] font-body text-[2.4vw] leading-snug text-muted">Authorize a phased deployment of the case-led control tower, beginning with onboarding and workforce-transfer operations.</p>
        <p className="mt-[3vh] font-body text-[2vw] leading-snug text-accent">Fund baseline measurement, configuration ownership, specialist authority assignments and provider-connectivity decisions.</p>
      </div>
      <div className="flex flex-col gap-[2vh]">
        <Card title="Approve now">Case orchestration, Action Center accountability, policy and evidence controls.</Card>
        <Card title="Do not assume" tone="amber">Payroll and benefits provider execution. These require separately configured, approved connections.</Card>
        <Card title="Governance gate" tone="slate">No sensitive or specialist decision proceeds on organization membership alone.</Card>
      </div>
    </div>
    <Footer value="Decision ask · Sponsor a controlled rollout and its operating prerequisites" />
  </div>;
}

export function Slide03() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[7vw] py-[6vh]">
    <Header section="Business problem" title="HR work breaks at handoffs" note="The friction is operational: context, ownership, evidence and timing separate as work moves." />
    <div className="my-[5vh] grid flex-1 grid-cols-3 gap-[2vw]">
      <Card title="People wait">Employees and managers repeat context across intake, documents, IT, HR and specialist queues.</Card>
      <Card title="Owners lose sight">Readiness depends on many prerequisites; a case status alone cannot establish a safe release.</Card>
      <Card title="Risk hides in gaps">Sensitive records, stale approvals and provider status labels can be mistaken for authority or completion.</Card>
    </div>
    <div className="border-t border-[#24406b] pt-[2.5vh] font-body text-[2vw] text-accent">Design response: one case record, explicit work ownership, evidence-aware gates and escalation before a consequential action.</div>
    <Footer />
  </div>;
}

export function Slide04() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[7vw] py-[6vh]">
    <Header section="Stakeholder value" title="Each role gets a clearer job to do" />
    <div className="my-[4vh] grid flex-1 grid-cols-2 gap-[2vw]">
      <Card title="Employees and managers">A visible request path, fewer repeated updates, transparent next steps and accountable follow-up.</Card>
      <Card title="HR operations">A shared queue, gateway readiness, exception handling, assignments and a record of what changed.</Card>
      <Card title="Specialists">Named, scoped review for legal, privacy, compliance, medical, payroll and transfer decisions.</Card>
      <Card title="Leaders and auditors">Aggregate operational reporting, traceable approvals, retention-aware recovery and a defensible rollout record.</Card>
    </div>
    <Footer value="Value is measured against each client’s starting volume, effort, timeliness, quality and risk baseline." />
  </div>;
}

export function Slide05() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[5vw] py-[6vh]">
    <Header section="All-HR service portfolio" title="Twelve case categories make the portfolio visible" note="Current Cases already holds service categories and scenario definitions; demo-safe sample coverage is being persisted for operational visibility." />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.4vw]">
      <Card title="Hire">Offer intake, candidate portal, documents, checks and readiness gateways.</Card>
      <Card title="Onboard">Day-1 coordination, access and asset tasks, communications, early-tenure plans and evidence.</Card>
      <Card title="Grow and move">Job-context changes, learning, compliance obligations, workforce transfers and controlled handoffs.</Card>
      <Card title="Pay and benefits" tone="amber">Case intake, ownership and readiness evidence now; provider execution only after a configured connection.</Card>
      <Card title="Leave and life events" tone="amber">Service case, policy guidance and specialist review; execution is a future connected-service decision.</Card>
      <Card title="Transition and exit">Transfer cutover, records, retention, holds, recovery and auditable completion.</Card>
    </div>
    <Footer value="All-HR case coverage is visible through categories and sample-safe scenarios · external execution remains provider-dependent and approval-bound." />
  </div>;
}

export function Slide06() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Current product surface" title="The control tower is implemented as connected views" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
      <Card title="Operate">Cases, case detail, readiness gateways, operational requests and Action Center.</Card>
      <Card title="Configure">Client Setup, checklists, job profiles, SLA/readiness, early tenure, privacy and membership settings.</Card>
      <Card title="Govern">Policy Assistant, policy library, policy review, guardrails, specialist authority and audit.</Card>
      <Card title="Observe">Analytics, bottleneck simulation, outcome KPIs, systems health, alerts and recommendations.</Card>
      <Card title="Assure">Learning Guide, UAT Test Center, Demo Center, evidence export and scoped synthetic cleanup.</Card>
      <Card title="All-HR case coverage">Twelve service categories and demo-safe scenario definitions support a common portfolio view; samples illustrate scope, not external completion.</Card>
    </div>
    <Footer value="Product surface reflects routes and views in the current application, reviewed 14 September 2026." />
  </div>;
}

export function Slide07() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Operating model" title="A case is the shared unit of HR work" note="The main helper is intended to unify cases across HR services." />
    <div className="my-[5vh] grid flex-1 grid-cols-4 gap-[1.4vw]">
      <Card title="1 · Capture">Create or receive a request with worker, service, context and evidence boundaries.</Card>
      <Card title="2 · Coordinate">Track stages, prerequisites, SLA timing, communication and dependent work.</Card>
      <Card title="3 · Decide">Route exceptions to a named human or verified specialist with current authority.</Card>
      <Card title="4 · Record">Keep outcomes, approvals, evidence provenance and recovery history together.</Card>
    </div>
    <div className="border-t border-[#24406b] pt-[2.5vh] font-body text-[2vw] text-accent">Implemented today: onboarding case orchestration, workforce-transfer programs and all-HR case categories. The main helper is unifying the case experience across services—not building payroll or benefits engines.</div>
    <Footer />
  </div>;
}

export function Slide08() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Execution boundary" title="Orchestrate the work before claiming provider completion" />
    <div className="my-[5vh] grid flex-1 grid-cols-2 gap-[2vw]">
      <Card title="Implemented case orchestration">
        <p>Cases, work items, due state, assignments, escalation, evidence, gateway checks and audit events are managed in the product.</p>
        <p className="mt-[2vh] text-accent">Action Center supports accountable human actions and case-linked work.</p>
      </Card>
      <Card title="Provider execution is not assumed" tone="amber">
        <p>Payroll, benefits and other provider outcomes remain distinct source-system evidence until an adapter is configured and its exchange is observed.</p>
        <p className="mt-[2vh] text-accent">A configuration status, simulation or UI label is not proof that a provider completed a change.</p>
      </Card>
    </div>
    <Footer value="Control principle · Separate request orchestration, human approval, provider dispatch and observed external outcome." />
  </div>;
}

export function Slide09() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Workforce runtime" title="Action Center makes human accountability operational" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.7vw]">
      <Card title="Visible work">Assign, reassign, escalate, resolve and reopen case-linked work with owner and due state.</Card>
      <Card title="Specialist lane">Legal, privacy, compliance, medical, payroll and other decisions route to named reviewers.</Card>
      <Card title="Service discipline">Evidence requirements, stale approval blocks, conflicts and retries remain visible rather than silently resolved.</Card>
    </div>
    <div className="grid grid-cols-2 gap-[2vw] border-t border-[#24406b] pt-[2.5vh]">
      <p className="font-body text-[1.9vw] leading-snug text-muted">Operational-request simulations and accountable human tasks are intentionally distinct.</p>
      <p className="font-body text-[1.9vw] leading-snug text-accent">Workforce runtime is the bridge from an HR service request to governed human or connected-provider execution.</p>
    </div>
    <Footer />
  </div>;
}

export function Slide10() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Onboarding and early tenure" title="Readiness is a sequence of evidence-backed gates" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
      <Card title="Gateway A · intake">Complete required facts and documents; return deficiencies to intake with a visible path.</Card>
      <Card title="Gateway B · review">Route background-check or other sensitive exceptions to HR and Compliance; no self-disposition.</Card>
      <Card title="Gateway C · Day 1">Review mandatory workstreams and fresh approval before release; a score is not a release decision.</Card>
      <Card title="Early tenure">Policy-configured Day-1, 30/60/90 and probation work is anchored to actual joining, not a planned date.</Card>
      <Card title="Candidate portal">Limited submission journey; portal data stays scoped to the associated case and confidential review.</Card>
      <Card title="Alerts and recovery">Surface overdue, stale, duplicate or conflicting work; preserve completed evidence when future work is rescheduled.</Card>
    </div>
    <Footer />
  </div>;
}

export function Slide11() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Workforce variants" title="Different populations keep their own hard controls" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
      <Card title="Frontline">Site, shift and skill context; medical fitness, safety sign-off and controlled floor release remain independent gates.</Card>
      <Card title="Transfer">Workforce-transfer programs track population, legal pathway, consultation, objections, cutover and readiness evidence.</Card>
      <Card title="Complex moves">Rehire, conversion, relocation, executive, contractor and bulk paths use applicable profiles and human review.</Card>
    </div>
    <div className="border-t border-[#24406b] pt-[2.5vh] font-body text-[2vw] leading-snug text-accent">No automated legal basis, work authorization, medical, accommodation, adverse hiring, pay-disruption or floor-release conclusion is asserted by the product.</div>
    <Footer />
  </div>;
}

export function Slide12() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Policy, AI and governance" title="AI informs work; authorized humans retain accountability" />
    <div className="my-[4vh] grid flex-1 grid-cols-2 gap-[2vw]">
      <Card title="Policy service">Policy Assistant returns cited guidance; the library, review workflow, versions and expiry reminders preserve governance context.</Card>
      <Card title="AI service">Agents, recommendations and workflow drafts are guarded inputs to review—not instructions to execute.</Card>
      <Card title="Authority controls" tone="amber">Organization membership is separate from verified specialist authority. Current scope and approval must be checked at the decision point.</Card>
      <Card title="Governance controls" tone="slate">Guardrails surface blocks and escalations; specialist decisions require named ownership and audit evidence.</Card>
    </div>
    <Footer value="Policy guidance or a draft is not an approved tenant policy or specialist conclusion." />
  </div>;
}

export function Slide13() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Trust and resilience" title="Privacy, audit and recovery are operating capabilities" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
      <Card title="Privacy by data class">Retention, lawful basis, jurisdiction and permitted-provider settings are explicit for sensitive lifecycle data.</Card>
      <Card title="Audit and archive">Case, approval, transfer and configuration events support redacted export, review, holds and retention-aware handling.</Card>
      <Card title="Recovery">Version checks, stale-state review, scoped retry and retention-aware cleanup protect history from accidental overwrite or deletion.</Card>
    </div>
    <div className="border-t border-[#24406b] pt-[2.5vh] font-body text-[2vw] leading-snug text-accent">Sensitive portal and specialist authority remain controlled boundaries. No generic UAT action can grant authority, authorize recipients or bypass live safeguards.</div>
    <Footer />
  </div>;
}

export function Slide14() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Management measurement" title="Measure service performance without exposing sensitive individuals" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
      <Card title="Flow">Intake completeness, gateway aging, cycle time, overdue work, rework and escalation volume.</Card>
      <Card title="Readiness">Mandatory-work completion, Day-1 readiness, provider evidence state and exception resolution.</Card>
      <Card title="Experience">Appropriate aggregate feedback, case updates, first-response timeliness and manager visibility.</Card>
      <Card title="Quality and risk">Approval freshness, policy exceptions, blocked actions, audit completeness and recovery outcomes.</Card>
      <Card title="Capacity">Workload by service, handoff queue, specialist demand and bottleneck simulations with stated assumptions.</Card>
      <Card title="Privacy boundary">Analytics are an insight layer. Small or sensitive cohorts are suppressed; individual employment decisions stay human-led.</Card>
    </div>
    <Footer value="Available views: Analytics, outcome KPIs, bottleneck simulator, recommendations, audit and systems health." />
  </div>;
}

export function Slide15() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Value case" title="Calculate value from the client baseline, not invented results" />
    <div className="my-[4vh] grid flex-1 grid-cols-2 gap-[2vw]">
      <Card title="Baseline inputs">
        <p>Service volumes and case mix</p><p className="mt-[1vh]">Current touch time and fully loaded role cost</p><p className="mt-[1vh]">Cycle time, rework, escalation and exception rates</p><p className="mt-[1vh]">Provider and change-management costs</p>
      </Card>
      <Card title="Calculation logic">
        <p>Capacity value = volume × verified time saved × loaded cost</p><p className="mt-[1vh]">Avoided rework = fewer repeat touches × baseline cost</p><p className="mt-[1vh]">Service value = measured timeliness and quality improvement</p><p className="mt-[1vh]">Net value = benefits less implementation, run and connection costs</p>
      </Card>
    </div>
    <div className="border-t border-[#24406b] pt-[2.5vh] font-body text-[2vw] leading-snug text-accent">Validate assumptions by service, cohort and period. Do not publish a percentage ROI, payback or customer result until baseline and observed outcomes exist.</div>
    <Footer />
  </div>;
}

export function Slide16() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Adoption" title="Adopt in phases that earn the next scope" />
    <div className="my-[5vh] grid flex-1 grid-cols-4 gap-[1.4vw]">
      <Card title="1 · Prepare">Name sponsor, service owner, data owner and specialist authorities; establish the baseline.</Card>
      <Card title="2 · Configure">Set client context, checklists, job profiles, policy references, SLAs, privacy and escalation rules.</Card>
      <Card title="3 · Pilot">Run a bounded onboarding or transfer cohort; review evidence, workload, exceptions and user adoption.</Card>
      <Card title="4 · Expand">Add service variants and only then evaluate provider connections under controlled change approval.</Card>
    </div>
    <Footer value="Expansion criteria: stable evidence quality, authority coverage, operating ownership, privacy review and measured pilot outcomes." />
  </div>;
}

export function Slide17() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Go-live conditions" title="Do not go live until the control environment is ready" />
    <div className="my-[4vh] grid flex-1 grid-cols-2 gap-[2vw]">
      <Card title="Business readiness">Named process owner; agreed service scope; baseline; support model; worker and manager communications; adoption training.</Card>
      <Card title="Control readiness">Verified specialist assignments; approved policies; escalation paths; retention and lawful-basis settings; audit and recovery procedures.</Card>
      <Card title="Technical readiness">Configured tenant context; validated checklists and profiles; source-system ownership; monitor health; provider connection decisions.</Card>
      <Card title="Evidence readiness" tone="amber">Role-appropriate UAT evidence, tracked defects, go/no-go review and explicit acceptance of any Manual or Blocked scope.</Card>
    </div>
    <Footer value="A portal, simulation or status label is not a substitute for an observed, authorized external effect." />
  </div>;
}

export function Slide18() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Assurance" title="Test Center distinguishes mapped coverage from verified evidence" />
    <div className="my-[4vh] grid flex-1 grid-cols-3 gap-[1.6vw]">
      <Card title="Mapped">The Learning Guide and catalog link features, roles, routes, scenarios and expected evidence. Mapping is not an execution result.</Card>
      <Card title="Observed">A tenant-scoped synthetic run records steps, outcomes, provenance, export and run-owned cleanup. Only this supports an execution assertion.</Card>
      <Card title="Blocked or manual" tone="amber">Provider sandbox, specialist review, real workflow and policy-dependent checks remain Manual or Blocked until independently authorized.</Card>
    </div>
    <div className="border-t border-[#24406b] pt-[2.5vh] font-body text-[2vw] leading-snug text-accent">No all-end-to-end certification is claimed. Test Center cannot promote users, authorize recipients, dispatch providers, certify vendors or establish live readiness.</div>
    <Footer value="Sensitive portal access and authority are pending controlled validation, not evidence of completed end-to-end certification." />
  </div>;
}

export function Slide19() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Appendix · target architecture" title="A service control plane sits between HR demand and external systems" />
    <div className="my-[4vh] flex flex-1 items-center gap-[1.2vw]">
      <Card title="Experience">Employee, manager, HR and specialist entry points</Card>
      <p className="font-display text-[3vw] text-accent">→</p>
      <Card title="Case spine">Context, policy, service routing, SLA and evidence</Card>
      <p className="font-display text-[3vw] text-accent">→</p>
      <Card title="Control plane">Action Center, approvals, authority, alerts and audit</Card>
      <p className="font-display text-[3vw] text-accent">→</p>
      <Card title="Execution boundary">Human work or separately configured provider connection</Card>
    </div>
    <div className="grid grid-cols-3 gap-[2vw] border-t border-[#24406b] pt-[2.5vh]">
      <p className="font-body text-[2vw] text-muted">Cross-cutting: privacy, retention, governance and recovery.</p>
      <p className="font-body text-[2vw] text-muted">Observability: health, events, workload, outcomes and exceptions.</p>
      <p className="font-body text-[2vw] text-accent">Design rule: the case records what is known; it does not invent external completion.</p>
    </div>
    <Footer value="Target architecture · technology choices and provider adapters are implementation decisions, not current product claims." />
  </div>;
}

export function Slide20() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[6vw] py-[6vh]">
    <Header section="Appendix · implementation boundary" title="Control-plane capability is ahead of provider execution" />
    <div className="my-[4vh] grid flex-1 grid-cols-2 gap-[2vw]">
      <Card title="Implemented in the current application">
        <p>Onboarding cases and readiness gateways</p><p className="mt-[1vh]">Action Center work and approvals</p><p className="mt-[1vh]">Workforce transfers and frontline controls</p><p className="mt-[1vh]">Policy, AI guardrails, privacy, audit, reporting and Test Center</p>
      </Card>
      <Card title="Requires future connection and evidence" tone="amber">
        <p>Payroll provider write-back or correction</p><p className="mt-[1vh]">Benefits enrollment or provider change</p><p className="mt-[1vh]">Leave-provider execution and other external service effects</p><p className="mt-[1vh]">Any provider result not actually configured and observed</p>
      </Card>
    </div>
    <Footer value="Case orchestration can coordinate these services now; each provider execution path needs its own authorization, adapter, monitoring and acceptance evidence." />
  </div>;
}

export function Slide21() {
  return <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg px-[5vw] py-[6vh]">
    <Header section="Appendix · feature coverage by view" title="Current product areas map to named views" note="Route/view coverage is a reference map, not a verification claim." />
    <div className="my-[3vh] grid flex-1 grid-cols-3 gap-[1.2vw]">
      <Card title="Operate">Cases · case detail · readiness · operational requests · Action Center · systems</Card>
      <Card title="Onboard">Standard and batch intake · candidate portal · early tenure · frontline pathway</Card>
      <Card title="Workforce">Workforce transfers · legal pathway · population · cutover · governance</Card>
      <Card title="Services">Payroll · benefits · leave · compliance specialist work tracked as service/control scope; execution connection is separate</Card>
      <Card title="Policy and AI">Policy Assistant · HR Policy Library · Policy Review · Agents · Recommendations · Guardrails</Card>
      <Card title="Measure">Analytics · outcome KPIs · bottleneck simulation · alerts · audit export</Card>
      <Card title="Trust">Privacy settings · retention/deletion jobs · recovery/version controls · specialist governance</Card>
      <Card title="Set up">Client Setup · job profiles · checklist and SLA settings · organization membership</Card>
      <Card title="Assure">Learning Guide · UAT Test Center · Demo Center · synthetic fixtures and scoped cleanup</Card>
    </div>
    <Footer value="Coverage state as of 14 September 2026 · Mapped views require run evidence for verified execution status." />
  </div>;
}