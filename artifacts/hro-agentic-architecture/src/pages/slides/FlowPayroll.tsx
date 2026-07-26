import FlowSlide from '../../components/FlowSlide';

export default function FlowPayroll() {
  return (
    <FlowSlide
      kicker="Lifecycle Flow 3 · Complex Case"
      title="Payroll Discrepancy Dispute"
      tags={['Multi-agent', 'Human-in-the-loop', 'Gated write-back']}
      asIsSteps={[
        'Ticket bounced payroll ↔ benefits ↔ HR',
        'Employee resubmits evidence',
        'Manual recalculation',
        'Correction lands next pay cycle',
      ]}
      asIsPain="2–4 weeks · repeated hand-offs · frequent escalations to management"
      toBeSteps={[
        { label: 'Employee uploads a payslip photo', refs: '①③' },
        {
          label: 'Case lead delegates: payroll agent recomputes, benefits agent checks deductions',
          refs: '⑤',
        },
        { label: 'Agents reconcile findings agent-to-agent', refs: '⑤' },
        {
          label: 'Proposed correction sent to a human approver',
          refs: '⑤',
          human: true,
        },
        { label: 'Approved fix written to payroll', refs: '⑥⑦' },
        { label: 'Employee notified · SLA case closed', refs: '⑥' },
      ]}
      outcome="Hours instead of weeks — the human approves the fix, never re-keys the data"
    />
  );
}
