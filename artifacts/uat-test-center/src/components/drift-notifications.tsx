import { useRef, useState } from "react";
import { useDriftNotifications } from "../hooks/use-drift-notifications";
import { usePolicyScope } from "../hooks/use-policies";
import { Button } from "./ui-shared";


export function DriftNotificationPreference() {
  const query = useDriftNotifications();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scope = usePolicyScope();
  const identity = `${scope.organizationId}:${scope.userId}`;
  const current = useRef(identity); current.current = identity;
  async function change() {
    if (!query.data) return;
    const submitted = identity;
    setBusy(true); setError("");
    try {
      await query.update({ action: query.data.optedIn ? "disable" : "enable", expectedVersion: query.data.version });
    } catch (e) {
      if (current.current === submitted) setError(e instanceof Error ? e.message : "Notification preference could not be saved.");
    } finally { setBusy(false); }
  }
  return <section className="border rounded-md p-3 space-y-2" aria-label="Private drift notification preference">
    <h3 className="font-semibold">Reviewer notifications — separate opt-in</h3>
    <p className="text-sm">Receive private in-app UAT alerts for changed provider receipts, changed or failed test answers, and paused drift programmes. No email address is inferred. No employee content, answers or receipt details are included. Notifications do not authorize or start model checks.</p>
    {query.isError && <p role="alert">Notification preference could not be loaded. <button className="underline" onClick={() => void query.refetch()}>Retry</button></p>}
    {query.data && <>
      <p className="text-sm">{query.data.enabled ? "Notifications enabled for your current verified reviewer authority." : query.data.optedIn ? "Notifications suspended: the authority used to opt in is no longer current. Turn off and opt in again after authority is verified." : "Notifications off."} Opting out hides existing notices; opting back in receives future warnings only.</p>
      {query.data.canSubscribe || query.data.optedIn
        ? <Button variant="outline" disabled={busy} onClick={() => void change()}>{query.data.optedIn ? "Turn off reviewer notifications" : "Opt in to private reviewer notifications"}</Button>
        : <p className="text-sm">Current verified HR compliance authority is required to receive notifications.</p>}
    </>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function DriftNotificationBanner() {
  const query = useDriftNotifications();
  const [error, setError] = useState("");
  if (query.isError || !query.data?.enabled || !query.data.notices.length) return null;
  return <aside className="mb-5 rounded-lg border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4" aria-label="Private UAT drift alerts">
    <h2 className="font-semibold">Test evaluation alerts</h2>
    <p className="text-sm">Review changed receipts or test results. These alerts do not authorize model spending.</p>
    {query.data.notices.map(notice => <div key={notice.id} className="mt-2 flex flex-wrap items-center gap-3 text-sm">
      <span>{notice.reasons.join(", ")}</span>
      <a className="underline" href={`${import.meta.env.BASE_URL}policy-quality`}>Review test evidence</a>
      <Button variant="outline" size="sm" onClick={() => {
        void query.update({ action: "acknowledge", noticeId: notice.id, expectedVersion: query.data!.version })
          .catch(() => setError("The alert could not be acknowledged. Refresh before retrying."));
      }}>Acknowledge</Button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </aside>;
}

