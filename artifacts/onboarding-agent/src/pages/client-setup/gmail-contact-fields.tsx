import type { GetOffboardingExchangeSetup200, OffboardingRecipient } from "@workspace/api-client-react";
import { Field, selectCls } from "../cases/separations/shared";

export function GmailContactFields({ choices, recipient: r, onChange }: {
  choices: GetOffboardingExchangeSetup200; recipient: OffboardingRecipient; onChange: (value: Partial<OffboardingRecipient>) => void;
}) {
  return <div className="grid min-w-0 gap-3 sm:grid-cols-2">{[false, true].map(escalation => {
    const memberKey = escalation ? "escalationMemberId" : "memberId";
    const addressKey = escalation ? "escalationAddress" : "address";
    const member = choices.members.find(m => m.id === r[memberKey]);
    return <div key={memberKey} className="min-w-0 space-y-2">
      <Field label={escalation ? "Escalation contact" : "Task owner"}><select className={selectCls} value={r[memberKey]} onChange={e => {
        const selected = choices.members.find(m => m.id === e.target.value);
        onChange({ [memberKey]: e.target.value, [addressKey]: selected?.addresses.length === 1 ? selected.addresses[0] : "" });
      }}><option value="">Choose named contact</option>{!member && r[memberKey] && <option value={r[memberKey]} disabled>Previous contact unavailable</option>}
        {choices.members.filter(m => !escalation || m.id !== r.memberId).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
      <Field label={escalation ? "Escalation email" : "Email address"}><select className={selectCls} value={r[addressKey]} onChange={e => onChange({ [addressKey]: e.target.value })}>
        <option value="">Choose email address</option>{member?.addresses.map(address => <option key={address} value={address}>{address}</option>)}
      </select></Field>
    </div>;
  })}</div>;
}

export const blankGmailRecipient = (taskId: string): OffboardingRecipient => ({
  taskId, memberId: "", address: "", persona: "", escalationMemberId: "", escalationAddress: "",
});
