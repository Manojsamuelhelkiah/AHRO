import type { OnbSyntheticJourney } from '@workspace/api-client-react';

export function SyntheticJourneySummary({ journey }: { journey: OnbSyntheticJourney }) {
  return <section aria-label="Case outcome" className="my-4 min-w-0 rounded-lg border p-4 text-sm break-words">
    <h2 className="font-semibold">{journey.qualifier}</h2>
    <p className="mt-2">{journey.rationale}</p>
  </section>;
}

export function SyntheticJourneyHealth({ journey }: { journey: OnbSyntheticJourney }) {
  const done = journey.stages.filter(stage => stage.status === 'completed').length;
  return <section aria-label="Case Health" className="mb-6 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {[
      ['Case Health', journey.qualifier],
      ['Stages', `${done} / ${journey.stages.length} completed · ${journey.outcome === 'rejected' ? 'Remaining work cancelled' : journey.outcome === 'blocked' ? 'Open requirement' : 'Supported scope complete'}`],
      ['SLA', 'Not measured'],
      ['Coordinating agent', journey.coordinatingAgent],
    ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border bg-[var(--surface)] p-4 break-words">
      <h3 className="mb-2 text-xs font-bold text-[var(--text-muted)]">{label}</h3>
      <p className="text-sm font-semibold">{value}</p>
    </div>)}
  </section>;
}

export function SyntheticJourneyActions({ journey }: { journey: OnbSyntheticJourney }) {
  return <section className="mb-6 min-w-0 rounded-lg border p-4 break-words">
    <h2 className="mb-3 font-semibold">Next Actions</h2>
    {journey.nextActions.length ? journey.nextActions.map(action => <p key={action}>{action}</p>)
      : <p>{journey.outcome === 'rejected' ? 'No pending work; downstream work cancelled.'
        : journey.family === 'Offboarding' ? 'No pending supported preparation. Final exit closure is unavailable pending approved section 4.6 requirements.'
          : 'No pending work.'}</p>}
  </section>;
}

export function SyntheticJourneyStages({ journey, timeline = false }: { journey: OnbSyntheticJourney; timeline?: boolean }) {
  return <section aria-label={timeline ? 'Case timeline' : 'Case workstreams'} className="min-w-0 space-y-4">
    <h2 className="font-semibold">{timeline ? 'Case timeline' : 'Workstreams'}</h2>
    <ol className="min-w-0 space-y-3">
      {journey.stages.map(stage => <li key={stage.id} className="min-w-0 rounded-lg border bg-[var(--surface)] p-4 text-sm break-words">
        <div className="flex flex-wrap justify-between gap-2 font-semibold">
          <h3>{stage.title}</h3><span>{stage.status}</span>
        </div>
        <dl className="mt-3 space-y-2">
          <div><dt className="inline font-semibold">Agent: </dt><dd className="inline">{stage.agent}</dd></div>
          <div><dt className="inline font-semibold">Responsible role: </dt><dd className="inline">{stage.role}</dd></div>
          <div><dt className="inline font-semibold">Depends on: </dt><dd className="inline">{stage.dependencies.map(id => journey.stages.find(s => s.id === id)?.title).join(', ') || 'Request intake — no prior stage'}</dd></div>
          <div><dt className="inline font-semibold">Evidence summary: </dt><dd className="inline">{stage.evidence}</dd></div>
          <div><dt className="inline font-semibold">Review / outcome: </dt><dd className="inline">{stage.decision}</dd></div>
        </dl>
      </li>)}
    </ol>
  </section>;
}

export function SyntheticJourneyCommunications({ journey }: { journey: OnbSyntheticJourney }) {
  return <section aria-label="Case correspondence" className="mb-6 min-w-0 space-y-3">
    <h2 className="font-semibold">Case correspondence</h2>
    <p className="text-sm text-[var(--text-muted)]">Prepared correspondence · Delivery not confirmed. Confirmed messages appear in message history with their delivery status.</p>
    {journey.stages.map(stage => <article key={stage.id} className="min-w-0 rounded-lg border p-4 text-sm break-words">
      <h3 className="font-semibold">{stage.title}</h3>
      <p className="mt-2 whitespace-pre-wrap">{stage.communication}</p>
    </article>)}
  </section>;
}
