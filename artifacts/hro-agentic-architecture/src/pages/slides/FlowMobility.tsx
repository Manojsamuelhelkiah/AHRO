import FlowSlide from '../../components/FlowSlide';
import { Slide11 } from '../../components/BusinessDeck';

export default Slide11;

export function LegacyFlowMobility() {
  return (
    <FlowSlide
      kicker="Lifecycle Flow 4 · Frontier"
      title="Cross-Border Relocation (Mover)"
      tags={['Beyond traditional RPA / chatbots', 'Deep reasoning', 'Multi-agent + human gates']}
      asIsSteps={[
        'HRBP + tax advisor + immigration firm trade emails',
        'Spreadsheets track 40+ steps',
        'Employee chases status for months',
      ]}
      asIsPain="8–12 weeks of fragmented hand-offs — too much judgment for classic automation"
      toBeSteps={[
        { label: 'Mover event proactively opens the case', refs: '①' },
        { label: 'Visa, contract & tax documents read on intake', refs: '③' },
        {
          label: 'Deep reasoning untangles tax, comp & benefits interactions',
          refs: '⑤',
        },
        {
          label: 'Immigration, comp & payroll agents coordinate the plan',
          refs: '⑤',
        },
        {
          label: 'Human sign-off at each critical gate',
          refs: '⑤',
          human: true,
        },
        { label: 'Changes executed across all systems', refs: '⑥⑦' },
        { label: 'Employee sees one live status in chat', refs: '①' },
      ]}
      outcome="Weeks instead of months — humans keep the judgment calls, agents do the coordination"
    />
  );
}
