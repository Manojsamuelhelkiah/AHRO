import FlowSlide from '../../components/FlowSlide';
import { Slide09 } from '../../components/BusinessDeck';

export default Slide09;

export function LegacyFlowPolicy() {
  return (
    <FlowSlide
      kicker="Lifecycle Flow 2 · Knowledge"
      title='Policy Question: "Can I carry over unused vacation?"'
      tags={['Grounded in HR policy database', 'Cited answers']}
      asIsSteps={[
        'Employee searches the intranet',
        'Finds outdated pages',
        'Emails the HRBP',
        'Waits for a reply',
        'Answers differ by person & country',
      ]}
      asIsPain="Days to answer · inconsistent guidance creates compliance risk"
      toBeSteps={[
        { label: 'Ask in any channel', refs: '①' },
        { label: 'Triage identifies a policy question', refs: '④' },
        {
          label: 'Country-aware lookup in the HR policy library',
          refs: '⑥',
        },
        { label: 'Fast reasoning composes a cited answer', refs: '⑤' },
        {
          label: 'Low confidence? routed to HR ops for review',
          refs: '⑤',
          human: true,
        },
      ]}
      outcome="Consistent, cited answers in seconds — one source of truth for every country"
    />
  );
}
