import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OnbSyntheticJourney } from '@workspace/api-client-react';
import { CASE_TYPES, caseSummary, workstreamPresentation } from '../case-presentation';
import { SyntheticJourneySummary, SyntheticJourneyActions, SyntheticJourneyStages,
  SyntheticJourneyCommunications } from './synthetic-journey';
import { CaseHealthStrip } from './components';
import { NextActions, OverviewTab } from './overview';
import { TasksTab } from './tabs-content';

function fixture(family: string, outcome: OnbSyntheticJourney['outcome']): OnbSyntheticJourney {
  return {
    version: 'synthetic-journey/v1', family, title: `${family} proposal`,
    outcome, qualifier: outcome, rationale: `${family} scenario-specific ${outcome} reason`,
    coordinatingAgent: `${family} Agent`,
    nextActions: outcome === 'blocked' ? [`${family} reviewer must resolve the source reference`] : [],
    stages: [
      { id: 'intake', title: `${family} intake`, date: '2030-10-01', status: 'completed',
        dependencies: [], agent: `${family} Agent`, agentKey: 'onboarding', agentVersion: 'hro-agents-v1', role: 'Coordinator',
        evidence: 'Request summary', decision: 'Request scoped', communication: 'Requester → coordinator: Review my proposal.' },
      { id: 'review', title: `${family} review`, date: '2030-10-02',
        status: outcome, dependencies: ['intake'], agent: `${family} Agent`, agentKey: 'onboarding', agentVersion: 'hro-agents-v1', role: 'Reviewer',
        evidence: 'Review worksheet', decision: `${family} decision ${outcome}`,
        communication: `Reviewer → requester: ${outcome} proposal.` },
    ],
  };
}

test('every family and mixed outcome agrees across health, overview, workstreams, next actions, timeline and communications', () => {
  for (const family of CASE_TYPES.filter(f => f !== 'All Cases')) {
    for (const outcome of ['completed', 'rejected', 'blocked'] as const) {
      const journey = fixture(family, outcome);
      const c = { id: 1, fictionalOfflineIdentity: true, offlineSample: true, syntheticJourney: journey,
        orchestrationStatus: 'blocked', lifecycleStage: 'service-intake',
        workstreams: [{ key: 'example-review', label: 'Old generic placeholder', status: 'pending', agent: 'none' }] };
      const summary = renderToStaticMarkup(<SyntheticJourneySummary journey={journey} />);
      const health = renderToStaticMarkup(<CaseHealthStrip c={c} pendingApprovals={[]} offlineSample />);
      const actions = renderToStaticMarkup(<NextActions c={c} pendingApprovals={[]} />);
      const tasks = renderToStaticMarkup(<TasksTab c={c} />);
      const overview = renderToStaticMarkup(<OverviewTab c={c} setTab={() => {}} />);
      const timeline = renderToStaticMarkup(<SyntheticJourneyStages journey={journey} timeline />);
      const communications = renderToStaticMarkup(<SyntheticJourneyCommunications journey={journey} />);
      assert.match(summary, new RegExp(outcome));
      assert.match(health, new RegExp(outcome));
      assert.match(health, /Not measured/);
      assert.match(overview, /Recorded operational history/);
      assert.match(overview, /service[- ]intake/i);
      assert.match(tasks, new RegExp(`${family} review`));
      assert.match(timeline, /Case timeline/);
      assert.match(timeline, new RegExp(`${family} intake`));
      assert.match(communications, /Case correspondence/);
      assert.doesNotMatch(summary + tasks + health + overview + timeline + communications,
        /Old generic placeholder|>none<|Manual Demo data|Offline sample|synthetic|illustrat|fictional/i);
      if (outcome === 'blocked') assert.match(actions, /must resolve the source reference/);
      else assert.match(actions, /No pending (?:work|supported preparation)/);
      assert.equal(caseSummary(c), `${journey.qualifier} · ${journey.rationale}`);
    }
  }
});

test('workstream cleanup never invents actual owners or changes specific genuine blockers', () => {
  const c = { caseFamily: 'Payroll' };
  assert.deepEqual(workstreamPresentation(c, { agent: 'none', owner: '', blockers: ['Independent identity review missing'] }), {
    agent: 'Payroll Agent', owner: 'No recorded owner — human assignment required',
    label: 'Unnamed workstream', blockers: ['Independent identity review missing'],
  });
  const actual = workstreamPresentation(c, { agent: 'payroll-specialist', owner: 'Recorded team', label: 'Cutoff review',
    blockers: ['Cutoff decision outstanding', 'Offline demo sample'] });
  assert.equal(actual.owner, 'Recorded team');
  assert.deepEqual(actual.blockers, ['Cutoff decision outstanding', 'Offline demo sample']);
  assert.equal(actual.label, 'Cutoff review');
});

test('offboarding completion is preparation only and preserves the unsupported closure blocker', () => {
  const journey = { ...fixture('Offboarding', 'completed'), qualifier: 'Preparation completed; final closure blocked' };
  assert.match(renderToStaticMarkup(<SyntheticJourneyActions journey={journey} />), /section 4.6/);
  assert.match(renderToStaticMarkup(<SyntheticJourneySummary journey={journey} />), /final closure blocked/);
});
