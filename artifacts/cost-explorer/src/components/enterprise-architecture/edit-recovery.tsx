import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type RejectedEdit = {
  id: string;
  order: number;
  label: string;
  draft: unknown;
  latest: unknown;
  archived: boolean;
  loading: boolean;
  loadFailed: boolean;
  reload: () => Promise<void>;
  onDiscard: () => void;
  retry: () => Promise<void>;
};

const RecoveryContext = createContext<{
  retain: (edit: RejectedEdit) => void;
  discard: (id: string) => void;
  hasConflicts: () => boolean;
  resolvedFields: Record<string, number>;
  resolveField: (field: string) => void;
  nextOrder: () => number;
} | null>(null);

export function useEditRecovery() {
  const context = useContext(RecoveryContext);
  if (!context) throw new Error("Assessment editor requires an edit recovery provider");
  return context;
}

export function EditRecoveryProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<RejectedEdit[]>([]);
  const editsRef = useRef<RejectedEdit[]>([]);
  const orderRef = useRef(0);
  const [resolvedFields, setResolvedFields] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const retain = (edit: RejectedEdit) => {
    editsRef.current = [...editsRef.current.filter(item => item.id !== edit.id), edit].sort((a, b) => a.order - b.order);
    setEdits(editsRef.current);
  };
  const discard = (id: string) => {
    const removed = editsRef.current.some(item => item.id === id);
    editsRef.current = editsRef.current.filter(item => item.id !== id);
    setEdits(editsRef.current);
    if (removed && editsRef.current[0]) void editsRef.current[0].reload();
  };
  const resolveField = (field: string) => setResolvedFields(current => ({ ...current, [field]: (current[field] ?? 0) + 1 }));
  return <RecoveryContext.Provider value={{ retain, discard, hasConflicts: () => editsRef.current.length > 0, resolvedFields, resolveField, nextOrder: () => orderRef.current++ }}>
    {edits.length > 0 && <section className="m-4 space-y-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-slate-900" aria-label="Unsaved edits">
      <h2 className="font-semibold">Resolve unsaved edits</h2>
      <p className="text-sm">Someone else changed this assessment. Your rejected drafts are kept here until you retry or discard them. Keep this workspace open until you finish.</p>
      {edits.map((edit, index) => <div key={edit.id} className="space-y-3 border-t border-amber-200 pt-3">
        <h3 className="font-medium">{edit.label}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          {[["Your rejected draft", edit.draft], ["Latest saved value", edit.latest]].map(([label, value]) =>
            <div key={String(label)}><h4 className="text-sm font-semibold">{String(label)}</h4>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-white p-3 text-xs">{JSON.stringify(value, null, 2) ?? (edit.loading ? "Loading…" : "Unavailable — reload the latest value to compare.")}</pre>
            </div>)}
        </div>
        {edit.archived && <p className="text-sm">This assessment is archived. Your draft is available to review, but cannot be saved.</p>}
        <p className="text-xs">Retry reapplies your changed fields, preserving unrelated changes. An edited record that was removed will be restored.</p>
        {edit.loadFailed && <p role="alert" className="text-sm">Could not load the latest assessment. Your draft is still preserved.</p>}
        {index > 0 && <p className="text-sm">Resolve the earlier draft first so dependent edits stay in order.</p>}
        <div className="flex gap-2">
          <Button disabled={index > 0 || busy !== null || edit.archived || edit.loading || edit.loadFailed} onClick={async () => {
            setBusy(edit.id);
            try { await edit.retry(); } finally { setBusy(null); }
          }}>Retry draft</Button>
          <Button variant="outline" disabled={busy !== null || edit.loading} onClick={async () => {
            setBusy(edit.id);
            try { await edit.reload(); } finally { setBusy(null); }
          }}>Reload latest</Button>
          <Button variant="outline" disabled={index > 0 || busy !== null || edit.loading} onClick={() => { edit.onDiscard(); discard(edit.id); }}>Discard draft</Button>
        </div>
      </div>)}
    </section>}
    <div inert={edits.length > 0 || undefined}>{children}</div>
  </RecoveryContext.Provider>;
}