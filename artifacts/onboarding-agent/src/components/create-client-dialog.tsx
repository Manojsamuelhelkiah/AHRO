import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { customFetch } from "@workspace/api-client-react";
import { hroBatchErrorMessage } from "../lib/hro-batch-intake-api";
import { enterClientWorkspace } from "../lib/enter-client-workspace";

export function CreateClientDialog({ onClose, initialName = "" }: { onClose: () => void; initialName?: string }) {
  const [name, setName] = useState(initialName);
  const [country, setCountry] = useState("US");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(false);
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
    <Dialog.Content onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus?.isConnected) returnFocus.focus(); }}
      onInteractOutside={event => event.preventDefault()}
      className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md max-h-[90dvh] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-[var(--text-primary)] shadow-xl">
    <form
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
          await enterClientWorkspace(result.organization.id);
        } catch (failure) {
          setError(wasCreated ? "The client was created but could not be entered. Reload the page and select it from the client list; do not create it again." : hroBatchErrorMessage(failure, "The client could not be created."));
          setBusy(false);
        }
      }}>
      <Dialog.Title className="text-lg font-semibold">Create client workspace</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-[var(--text-secondary)]">Creates a client workspace with separate client data and enters it. Saving a Client Setup implementation plan does not create a workspace. Policies and operational approvals require separate review.</Dialog.Description>
      <label className="mt-4 block text-sm">Client workspace name
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
        {created && !busy && <button type="button" onClick={() => window.location.reload()} className="rounded border px-3 py-2">Reload client workspaces</button>}
        <button type="submit" disabled={created || busy || name.trim().length < 2} className="rounded bg-[var(--primary)] px-3 py-2 text-white disabled:opacity-50" data-testid="button-create-client-confirm">
          {busy ? "Creating…" : "Create and enter client workspace"}
        </button>
      </div>
    </form>
    </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
