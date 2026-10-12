import { useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { hroBatchErrorMessage } from "../lib/hro-batch-intake-api";

export function CreateClientDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [country, setCountry] = useState("US");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onKeyDown={event => { if (event.key === "Escape" && !busy) onClose(); }}>
    <form role="dialog" aria-modal="true" aria-labelledby="create-client-title"
      className="w-full max-w-md max-h-[90dvh] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text-primary)] shadow-xl"
      onSubmit={async event => {
        event.preventDefault();
        if (busy) return;
        setBusy(true); setError("");
        let wasCreated = false;
        try {
          const result = await customFetch<{ organization: { id: string } }>("/api/organizations", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim(), primaryCountry: country.trim().toUpperCase() }),
          });
          wasCreated = true;
          setCreated(true);
          if (!result.organization?.id) throw new Error("The client was created but its workspace identity could not be confirmed. Reload the client list before trying again.");
          window.localStorage.setItem("activeOrganizationId", result.organization.id);
          window.location.reload();
        } catch (failure) {
          setError(wasCreated ? "The client was created but could not be entered. Reload the page and select it from the client list; do not create it again." : hroBatchErrorMessage(failure, "The client could not be created."));
          setBusy(false);
        }
      }}>
      <h2 id="create-client-title" className="text-lg font-semibold">Create client workspace</h2>
      <p className="mt-2 text-sm text-[var(--text-secondary)]">Creates a separate client organization and enters it. This is different from saving a Client Setup implementation plan. Use fictional client data during development. Policies and operational approvals are not automatically granted.</p>
      <label className="mt-4 block text-sm">Client name
        <input autoFocus required minLength={2} maxLength={100} disabled={busy} value={name} onChange={event => setName(event.target.value)}
          className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface-alt)] p-2" data-testid="input-new-client-name" />
      </label>
      <label className="mt-3 block text-sm">Primary country
        <select disabled={busy} value={country} onChange={event => setCountry(event.target.value)}
          className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface-alt)] p-2" data-testid="select-new-client-country">
          {["US", "IN", "GB", "SG", "AU", "CA", "DE", "FR"].map(code => <option key={code}>{code}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--status-red)]">{error}</p>}
      <div className="mt-5 flex flex-wrap justify-end gap-3">
        <button type="button" disabled={busy} onClick={onClose} className="rounded border border-[var(--border)] px-3 py-2">Cancel</button>
        {created && !busy && <button type="button" onClick={() => window.location.reload()} className="rounded border px-3 py-2">Reload client list</button>}
        <button type="submit" disabled={created || busy || name.trim().length < 2} className="rounded bg-[var(--primary)] px-3 py-2 text-white disabled:opacity-50" data-testid="button-create-client-confirm">
          {busy ? "Creating…" : "Create and enter client"}
        </button>
      </div>
    </form>
  </div>;
}
