import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { registerLeaveProtection } from "./leave-guard";
import { rebaseEdit } from "./rebase-edit";

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

type SavedMerge = { submitted: unknown; latest: unknown; expectedEditor: unknown };
const RecoveryContext = createContext<{
  retain: (edit: RejectedEdit) => void;
  discard: (id: string) => void;
  hasConflicts: () => boolean;
  resolvedFields: Record<string, number>;
  resolvedDrafts: Record<string, unknown>;
  resolveField: (field: string, submitted: unknown) => void;
  nextOrder: () => number;
  trackUnsaved: (id: string, unsaved: boolean) => void;
  trackDraft: (id: string, draft: { discard: () => void; label: string } | null) => void;
  prepareSavedMerge: (field: string, submitted: unknown, latest: unknown, expectedEditor?: unknown) => void;
  getSavedMerge: (field: string) => SavedMerge | undefined;
} | null>(null);

export function useEditRecovery() {
  const context = useContext(RecoveryContext);
  if (!context) throw new Error("Assessment editor requires an edit recovery provider");
  return context;
}

/** Protect input state before its blur handler has submitted anything. */
export function useDraftProtection(draft: unknown, saved: unknown, discard: () => void, label: string) {
  const id = useId();
  const { trackDraft } = useEditRecovery();
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useLayoutEffect(() => {
    trackDraft(id, dirty ? { discard, label } : null);
  }, [id, dirty, discard, label, trackDraft]);
  useLayoutEffect(() => () => trackDraft(id, null), [id, trackDraft]);
}

/** Cache refreshes are not permission to reset edits made since the last save. */
export function useMergeSavedDraft<T>(
  saved: T,
  setDraft: Dispatch<SetStateAction<T>>,
  field?: string,
  select?: (value: any) => T,
) {
  const previous = useRef(saved);
  const consumedMerge = useRef<SavedMerge | undefined>(undefined);
  const { getSavedMerge } = useEditRecovery();
  const merge = field ? getSavedMerge(field) : undefined;
  useLayoutEffect(() => {
    let before = previous.current;
    let next = saved;
    previous.current = saved;
    const matchesResponse = merge && consumedMerge.current !== merge
      && JSON.stringify(select ? select(merge.latest) : merge.latest) === JSON.stringify(saved);
    if (matchesResponse) {
      // The previous saved value cannot identify a deliberate reversion made
      // during a request. Compare with what that request actually submitted.
      before = (select ? select(merge.submitted) : merge.submitted) as T;
      next = (select ? select(merge.expectedEditor) : merge.expectedEditor) as T;
      consumedMerge.current = merge;
    } else if (JSON.stringify(before) === JSON.stringify(saved)) return;
    setDraft(current => rebaseEdit(before, current, next) as T);
  }, [saved, setDraft, merge, select]);
}
export function EditRecoveryProvider({ children }: { children: ReactNode }) {
  const [edits, setEdits] = useState<RejectedEdit[]>([]);
  const editsRef = useRef<RejectedEdit[]>([]);
  const orderRef = useRef(0);
  const unsavedRef = useRef(new Set<string>());
  const draftsRef = useRef(new Map<string, { discard: () => void; label: string }>());
  const savedMerges = useRef(new Map<string, SavedMerge>());
  const prepareSavedMerge = useCallback((field: string, submitted: unknown, latest: unknown, expectedEditor: unknown = latest) => {
    savedMerges.current.set(field, { submitted, latest, expectedEditor });
  }, []);
  const getSavedMerge = useCallback((field: string) => savedMerges.current.get(field), []);
  const [draftCount, setDraftCount] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const trackDraft = useCallback((id: string, draft: { discard: () => void; label: string } | null) => {
    const before = draftsRef.current.size;
    if (draft) draftsRef.current.set(id, draft);
    else draftsRef.current.delete(id);
    if (before !== draftsRef.current.size) setDraftCount(draftsRef.current.size);
  }, []);
  const trackUnsaved = useCallback((id: string, unsaved: boolean) => {
    if (unsaved) unsavedRef.current.add(id);
    else unsavedRef.current.delete(id);
    if (id.startsWith("pending:")) {
      setPendingCount([...unsavedRef.current].filter(key => key.startsWith("pending:")).length);
    }
  }, []);
  useEffect(() => registerLeaveProtection(() =>
    editsRef.current.length > 0 || unsavedRef.current.size > 0 || draftsRef.current.size > 0
  ), []);
  const [resolvedFields, setResolvedFields] = useState<Record<string, number>>({});
  const resolvedDrafts = useRef<Record<string, unknown>>({});
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
  const resolveField = (field: string, submitted: unknown) => {
    resolvedDrafts.current[field] = submitted;
    setResolvedFields(current => ({ ...current, [field]: (current[field] ?? 0) + 1 }));
  };
  return <RecoveryContext.Provider value={{ retain, discard, trackUnsaved, trackDraft, prepareSavedMerge, getSavedMerge, hasConflicts: () => editsRef.current.length > 0, resolvedFields, resolvedDrafts: resolvedDrafts.current, resolveField, nextOrder: () => orderRef.current++ }}>
    {draftCount > 0 && edits.length === 0 && <section className="m-4 flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-slate-900" aria-label="Unsubmitted drafts">
      <p className="flex-1 text-sm">Unsaved edits. Finish editing to save. For privacy, drafts are kept only in this open workspace.</p>
      <Button variant="outline" disabled={pendingCount > 0}
        onMouseDown={event => event.preventDefault()}
        onClick={() => {
          if (pendingCount > 0 || !window.confirm("Discard unsaved inline edits and use the saved values?")) return;
          [...draftsRef.current.values()].forEach(draft => draft.discard());
        }}>Discard inline drafts</Button>
    </section>}
    {edits.length > 0 && <section className="m-4 space-y-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-slate-900" aria-label="Unsaved edits">
      <h2 className="font-semibold">Resolve unsaved edits</h2>
      <p className="text-sm">A save failed or this assessment changed elsewhere. Your drafts are kept here and automatic saves are paused until you retry or discard them. An interrupted save may already have reached the server; compare the latest saved value before retrying. For privacy, drafts are not stored in your browser. Leaving or reloading will lose them; you will be warned before leaving.</p>
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

/** Resolve only the submitted snapshot, preserving edits typed after submission. */
export function resolveSubmittedDraft<T>(setDraft: Dispatch<SetStateAction<T>>) {
  return (latest: T, submitted?: T) =>
    setDraft(current => submitted === undefined ? latest : rebaseEdit(submitted, current, latest) as T);
}
