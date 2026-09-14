const stages = [
  {
    stage: 'Contract & Onboard',
    color: '#7ac9f5',
    when: 'signature → go-live',
    docs: [
      ['MSA / Terms of Service', 'the master contract — liability, IP, warranties, termination'],
      ['Order Form / SOW', 'scope, tiers, pricing, onboarding deliverables'],
      ['Acceptable Use Policy', 'what customers can & can\u2019t do — no scraping, misuse, unlawful content'],
      ['DPA + SCCs', 'GDPR data processing terms, cross-border transfer clauses'],
      ['SLA Schedule', 'uptime & resolution commitments, credit mechanics'],
    ],
  },
  {
    stage: 'Live Operations',
    color: '#8fd6a8',
    when: 'continuous, in-product',
    docs: [
      ['Privacy Notice', 'what employee data is processed, why, and for how long'],
      ['AI Transparency Notice', 'EU AI Act — users know they interact with AI; HITL disclosed'],
      ['AI Output Disclaimer', 'answers are policy-grounded assistance, not legal/tax advice'],
      ['Subprocessor List', 'Azure, model providers — with change-notification rights'],
      ['Trust Center Pack', 'SOC 2 / ISO 27001 reports, pen-test summaries under NDA'],
    ],
  },
  {
    stage: 'Change & Update',
    color: '#d9b36a',
    when: 'per release / model change',
    docs: [
      ['Release Notes', 'features, fixes, deprecations — functional documentation'],
      ['Change Notifications', 'material changes to terms, models, or subprocessors'],
      ['Model / Feature Cards', 'what changed in AI behaviour, evals run, known limits'],
      ['Updated User Guides', 'admin & end-user documentation kept in step'],
    ],
  },
  {
    stage: 'Incident & Exit',
    color: '#e0917f',
    when: 'event-driven / renewal',
    docs: [
      ['Incident Notification', 'breach notice within contractual/legal windows (72h GDPR)'],
      ['RCA / Post-Incident Report', 'root cause, impact, remediation for affected tenants'],
      ['Audit & Compliance Reports', 'annual attestations, regulator-facing evidence'],
      ['Exit & Data Return Plan', 'export formats, deletion certificate, transition assistance'],
    ],
  },
];

import { Slide20 } from '../../components/BusinessDeck';

export default Slide20;

export function LegacyLegalDocs() {
  return (
    <div className="w-screen h-screen overflow-hidden relative bg-bg">
      <div className="absolute inset-0 bg-gradient-to-br from-[#0a1526] via-[#0c1a30] to-[#0a1526]" />
      <div className="absolute top-0 left-0 h-[1vh] w-[99vw] bg-primary" />
      <div className="absolute inset-0 flex flex-col px-[3.5vw] py-[3.2vh]">
        <div className="flex items-baseline justify-between">
          <h2 className="font-display font-bold text-text text-[2.2vw] tracking-tight">
            Legal &amp; Product Documentation — Post-Release
          </h2>
          <p className="font-body text-muted text-[1.1vw]">
            the right document, at the right lifecycle stage
          </p>
        </div>

        <div className="grid grid-cols-4 gap-[1vw] mt-[1.6vh] flex-1 min-h-0">
          {stages.map((s) => (
            <div
              key={s.stage}
              className="rounded-[0.6vw] border bg-[#0d1e36] px-[0.9vw] py-[1vh] flex flex-col"
              style={{ borderColor: s.color }}
            >
              <p className="font-display font-bold text-[1.25vw]" style={{ color: s.color }}>
                {s.stage}
              </p>
              <p className="font-body text-muted text-[0.9vw] mb-[0.8vh]">{s.when}</p>
              <div className="flex flex-col gap-[0.8vh] flex-1">
                {s.docs.map(([name, desc]) => (
                  <div key={name}>
                    <p className="font-body text-text font-semibold text-[1vw] leading-snug">{name}</p>
                    <p className="font-body text-muted text-[0.92vw] leading-snug">{desc}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="bg-[#111f38] border border-[#24406b] rounded-[0.6vw] px-[1vw] py-[0.8vh] mt-[1vh]">
          <p className="font-body text-muted text-[1.02vw] leading-snug">
            <span className="text-text font-semibold">Operating principle</span> — contractual documents (MSA, DPA, SLA) are versioned and countersigned; in-product notices (AUP, privacy, AI transparency) are always-current and linked from the assistant itself; event-driven documents (incidents, RCAs, exit plans) have contractual clocks. One legal register tracks which version each tenant is on.
          </p>
        </div>
      </div>
    </div>
  );
}
