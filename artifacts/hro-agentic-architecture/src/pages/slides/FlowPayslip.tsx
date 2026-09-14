import FlowSlide from '../../components/FlowSlide';
import { Slide08 } from '../../components/BusinessDeck';

export default Slide08;

export function LegacyFlowPayslip() {
  return (
    <FlowSlide
      kicker="Lifecycle Flow 1 · High Volume"
      title="Payslip Copy & Leave Balance"
      tags={['Repetitive', 'Deterministic — no reasoning at run time']}
      asIsSteps={[
        'Employee emails shared HR inbox',
        'Ticket created & queued',
        'Agent looks up payroll system',
        'Replies with PDF',
        'Ticket closed manually',
      ]}
      asIsPain="1–2 days per request · thousands of identical requests every month"
      toBeSteps={[
        { label: 'Employee asks the HR persona in Teams', refs: '①' },
        { label: 'Recognized as a known request type', refs: '④' },
        { label: 'Approved tool fetches the payslip', refs: '⑥' },
        { label: 'Straight from payroll', refs: '⑦' },
        { label: 'Delivered in chat · case auto-logged', refs: '⑥' },
      ]}
      outcome="Seconds instead of days · zero human touch · every retrieval audited"
    />
  );
}
