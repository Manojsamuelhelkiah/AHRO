import { useRef, useState } from "react";
import { Link } from "wouter";
import { useDriftNotifications } from "../hooks/use-drift-notifications";
import { usePolicyScope } from "../hooks/use-policies";
import { Button } from "./ui-shared";

const labels = {
  "provider-changed": "Provider model receipts changed",
  "answer-regression": "Synthetic answers changed or failed",
  "programme-paused": "Synthetic drift programme paused",
};

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
    <p className="text-sm">Receive private in-app alerts across the control tower for changed provider receipts, changed or failed synthetic answers, and paused drift programmes. No email address is inferred. No employee content, answers or receipt details are included. Notifications do not authorize or start model checks.</p>
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
  const scope = usePolicyScope();
  const identity = `${scope.organizationId}:${scope.userId}`;
  const current = useRef(identity); current.current = identity;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ identity: string; message: string } | null>(null);
  async function acknowledge(id: string) {
    if (!query.data) return;
    const submitted = identity;
    setBusy(true); setError(null);
    try { await query.update({ action: "acknowledge", noticeId: id, expectedVersion: query.data.version }); }
    catch (e) {
      if (current.current === submitted) setError({ identity, message: e instanceof Error ? e.message : "Notice could not be acknowledged." });
    } finally { setBusy(false); }
  }
  // Never keep showing a cached notice when its fresh authorization request fails.
  if (query.isError || !query.data?.enabled || !query.data.notices.length) return null;
  return <aside className="border-b p-3 space-y-2 bg-[var(--surface-soft)]" aria-label="Private reviewer drift notifications">
    <p className="font-semibold" role="status">{query.data.notices.length} synthetic model drift {query.data.notices.length === 1 ? "notice" : "notices"} requiring review</p>
    <details>
      <summary className="cursor-pointer text-sm">View private reviewer notices</summary>
      {query.data.notices.map(n => <div key={n.id} className="text-sm border-t py-2 space-y-1">
        <p>{n.reasons.map(r => labels[r]).join(" · ")}</p>
        <p>Programme {n.programmeId} · {n.runId ? `run ${n.runId}` : "no run dispatched"} · {n.createdAt}</p>
        <div className="flex items-center gap-3">
          <Link className="underline" href="/uat-test-center#policy-quality">Review synthetic evidence</Link>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void acknowledge(n.id)}>Acknowledge</Button>
        </div>
      </div>)}
    </details>
    {error?.identity === identity && <p role="alert">{error.message}</p>}
  </aside>;
}
