import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '@clerk/react';
import { Link } from 'wouter';
import { format } from 'date-fns';
import { ChevronDown, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  getActionConversation,
  getPinnedOrganizationIdForPage,
  postActionConversation,
  type ActionConversation as ConversationData,
  type ActionConversationInput,
  type ActionConversationMessage,
  type OnbCaseExplanation,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui-shared';

const POLL_MS = 10_000;
const MAX_TEXT = 4000;

type Mode = 'note' | 'triage';
type Frozen = { submissionId: string; body: ActionConversationInput };

const STATE_LABEL: Record<ActionConversationMessage['state'], string> = {
  recorded: 'Recorded',
  pending: 'Working',
  completed: 'Completed',
  failed: 'Failed',
  uncertain: 'Outcome uncertain',
  withheld: 'Withheld',
};
const OUTCOME_LABEL: Record<string, string> = {
  answer: 'Answer',
  clarification: 'Needs clarification',
  proposal: 'Proposal',
  unavailable: 'Unavailable',
};

function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function merge(current: ActionConversationMessage[], incoming: ActionConversationMessage[]) {
  const map = new Map<number, ActionConversationMessage>();
  for (const m of current) map.set(m.id, m);
  for (const m of incoming) {
    const prev = map.get(m.id);
    if (!prev || m.version >= prev.version) map.set(m.id, m);
  }
  return Array.from(map.values()).sort((a, b) => a.id - b.id);
}

function errorText(error: unknown): { text: string; ambiguous: boolean } {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    const error2 = error as { status: number; message: string; data?: unknown };
    const data = (error2.data ?? null) as { message?: string; error?: string } | null;
    const detail = data?.message || data?.error || error2.message;
    if (status === 401) return { text: 'Your session is no longer valid. Sign in again to continue.', ambiguous: false };
    if (status === 403) return { text: `Access denied. Reading or posting here needs current case-flow permission for this case and workspace; membership labels alone do not grant it. ${detail}`, ambiguous: false };
    if (status === 404) return { text: 'This case was not found in the current workspace, or you cannot view it.', ambiguous: false };
    const ambiguous = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    return { text: detail, ambiguous };
  }
  return { text: 'The connection dropped before a response arrived. The request may or may not have been recorded.', ambiguous: true };
}

function safeReviewHref(href: string | null, caseId: number): string | null {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return null;
  const bound = href.includes(`/cases/${caseId}`) || new RegExp(`[?&]caseId=${caseId}(&|$)`).test(href);
  return bound ? href : null;
}

export function ActionConversationPanel({ caseId, workItemId }: { caseId: number; workItemId?: number }) {
  const { userId, sessionId } = useAuth();
  const org = getPinnedOrganizationIdForPage() ?? 'none';
  // Any scope change remounts the child, discarding drafts, messages and requests.
  const scope = `${org}|${userId ?? ''}|${sessionId ?? ''}|${caseId}|${workItemId ?? ''}`;
  return <ConversationInner key={scope} caseId={caseId} workItemId={workItemId} />;
}

function ConversationInner({ caseId, workItemId }: { caseId: number; workItemId?: number }) {
  const [data, setData] = useState<Omit<ConversationData, 'messages' | 'nextBefore'> | null>(null);
  const [messages, setMessages] = useState<ActionConversationMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderError, setOlderError] = useState('');
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('triage');
  const [agentKey, setAgentKey] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [frozen, setFrozen] = useState<Frozen | null>(null);
  const [attempt, setAttempt] = useState(0);

  const controllerRef = useRef(new AbortController());
  const sendingRef = useRef(false);
  const live = useRef(true);
  const readEpoch = useRef(0);

  useEffect(() => {
    live.current = true;
    const controller = controllerRef.current;
    return () => {
      live.current = false;
      controller.abort();
    };
  }, []);

  const params = useMemo(() => (workItemId ? { workItemId } : undefined), [workItemId]);

  const failClosed = useCallback((e: unknown) => {
    readEpoch.current++;
    setMessages([]);
    setNextBefore(null);
    setData(null);
    setText('');
    setFrozen(null);
    setStatus('error');
    setLoadError(errorText(e).text);
  }, []);

  const refresh = useCallback(async () => {
    const epoch = ++readEpoch.current;
    try {
      const res = await getActionConversation(caseId, params, { signal: controllerRef.current.signal, credentials: 'include' });
      if (!live.current || controllerRef.current.signal.aborted || epoch !== readEpoch.current) return;
      if (res.caseId !== caseId) throw new Error('Response was for a different case.');
      const { messages: page, nextBefore: nb, ...rest } = res;
      setData(rest);
      // A fresh page authorizes only that page. Discard older cached replies
      // rather than leaving their excerpts visible after disclosure changes.
      setMessages(page);
      setNextBefore(nb);
      setStatus('ready');
      setLoadError('');
    } catch (e) {
      if (!live.current || controllerRef.current.signal.aborted || epoch !== readEpoch.current) return;
      failClosed(e);
    }
  }, [caseId, params, failClosed]);

  useEffect(() => {
    setStatus('loading');
    void refresh();
  }, [refresh, attempt]);

  const needsPolling = sending || messages.some((m) => m.state === 'pending');
  useEffect(() => {
    if (status !== 'ready') return;
    const t = setInterval(() => { if (!document.hidden) void refresh(); }, needsPolling ? POLL_MS : 30_000);
    const focused = () => { void refresh(); };
    window.addEventListener('focus', focused);
    return () => { clearInterval(t); window.removeEventListener('focus', focused); };
  }, [needsPolling, status, refresh]);

  const loadOlder = async () => {
    if (nextBefore == null || olderBusy) return;
    const epoch = readEpoch.current;
    setOlderBusy(true);
    setOlderError('');
    try {
      const res = await getActionConversation(caseId, { ...(params ?? {}), before: nextBefore }, { signal: controllerRef.current.signal, credentials: 'include' });
      if (!live.current || controllerRef.current.signal.aborted || epoch !== readEpoch.current) return;
      if (res.caseId !== caseId) throw new Error('Response was for a different case.');
      setMessages((cur) => merge(cur, res.messages));
      setNextBefore(res.nextBefore);
    } catch (e) {
      if (live.current && !controllerRef.current.signal.aborted && epoch === readEpoch.current) failClosed(e);
    } finally {
      if (live.current) setOlderBusy(false);
    }
  };

  const dispatch = async (job: Frozen) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError('');
    try {
      await postActionConversation(caseId, job.body, { signal: controllerRef.current.signal, credentials: 'include' });
      if (!live.current || controllerRef.current.signal.aborted) return;
      // Durable acknowledgement: forget the submission and draft.
      setFrozen(null);
      setText('');
      await refresh();
    } catch (e) {
      if (!live.current || controllerRef.current.signal.aborted) return;
      const { text: t, ambiguous } = errorText(e);
      setSendError(t);
      if ([401, 403, 404].includes(Number((e as { status?: number })?.status))) {
        failClosed(e);
      }
      if (ambiguous) setFrozen(job);
      else setFrozen(null);
    } finally {
      sendingRef.current = false;
      if (live.current) setSending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (frozen) return void dispatch(frozen);
    const trimmed = text.trim();
    if (!trimmed || !data?.canPost) return;
    const body: ActionConversationInput = {
      submissionId: newId(),
      text: trimmed,
      mode,
      ...(mode === 'triage' && agentKey ? { agentKey } : {}),
      ...(workItemId ? { workItemId } : {}),
    };
    void dispatch({ submissionId: body.submissionId, body });
  };

  if (status === 'loading') {
    return (
      <div className="space-y-3" role="status" aria-label="Loading conversation">
        {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-[var(--radius-lg)] bg-[var(--surface-soft)]" />)}
      </div>
    );
  }
  if (status === 'error' || !data) {
    return (
      <div role="alert" className="rounded-[var(--radius-lg)] border border-[var(--status-red)] bg-[var(--status-red-bg)] p-4 text-sm text-[var(--status-red-fg)]">
        <p className="font-semibold">Conversation could not be loaded for Case #{caseId}.</p>
        <p className="mt-1">{loadError}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setAttempt((v) => v + 1)}><RefreshCw className="mr-1 h-3 w-3" /> Retry</Button>
      </div>
    );
  }

  const locked = !!frozen;
  const over = text.length > MAX_TEXT;

  return (
    <section aria-label={`Case ${caseId} conversation`} className="space-y-4">
      <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--primary)]" aria-hidden />
        <div className="min-w-0 text-sm text-[var(--text-secondary)]">
          <p className="font-semibold text-[var(--text-primary)]">Case #{caseId}{workItemId ? ` · Work item #${workItemId}` : ''} <Link href={`/cases/${caseId}`} className="ml-2 text-xs font-semibold text-[var(--primary)] hover:underline">Open case</Link></p>
          <p className="mt-1">{data.notice}</p>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Notes are human annotations only and are never sent to a model. Replies are read-only; no proposal is executed. Review the evidence, then act through the case or approval queue.</p>
        </div>
      </div>

      {nextBefore != null && (
        <div className="text-center">
          <Button size="sm" variant="outline" onClick={loadOlder} disabled={olderBusy}>
            {olderBusy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}Load older messages
          </Button>
          {olderError && <p role="alert" className="mt-2 text-xs text-[var(--status-red-fg)]">{olderError}</p>}
        </div>
      )}

      <ol aria-live="polite" aria-label="Messages, oldest first" className="space-y-3">
        {messages.length === 0 && (
          <li className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">
            No messages on this case yet. Record a note or ask for case triage below.
          </li>
        )}
        {messages.map((m) => <MessageItem key={m.id} m={m} caseId={caseId} />)}
      </ol>

      <form onSubmit={submit} className="space-y-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
        {!data.canPost && (
          <p role="status" className="rounded bg-[var(--status-amber-bg)] px-3 py-2 text-xs text-[var(--status-amber-fg)]">
            You can read this conversation but cannot post. Posting requires current case-flow permission for this case in this workspace.
          </p>
        )}
        <fieldset disabled={!data.canPost || locked || sending} className="space-y-3">
          <legend className="sr-only">Compose</legend>
          <div role="radiogroup" aria-label="Message type" className="flex flex-wrap gap-2">
            {([['triage', 'Ask for triage'], ['note', 'Human note']] as const).map(([v, label]) => (
              <label key={v} className={`inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-xs font-semibold focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--primary)] ${mode === v ? 'border-[var(--primary)] bg-[var(--primary-light-bg)] text-[var(--primary)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}>
                <input type="radio" className="sr-only" name="conv-mode" value={v} checked={mode === v} onChange={() => setMode(v)} />
                {label}
              </label>
            ))}
          </div>
          <p className="text-xs text-[var(--text-muted)]">
            {mode === 'note' ? 'Saved as your annotation. It is not source evidence and is never sent to a model.' : 'Read-only triage over this case, authorized by you. No agent needs to be selected.'}
          </p>
          {mode === 'triage' && (
            <div>
              <label htmlFor="conv-agent" className="text-xs font-semibold text-[var(--text-secondary)]">Address a catalogue agent (optional)</label>
              <select id="conv-agent" value={agentKey} onChange={(e) => setAgentKey(e.target.value)} className="mt-1 h-9 w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm">
                <option value="">No agent — default case triage</option>
                {data.agents.map((a) => (
                  <option key={a.key} value={a.key}>{a.role} ({a.key}) — {a.eligible ? 'registered, eligible for read-only triage' : 'not available'}</option>
                ))}
              </select>
              {agentKey && (() => {
                const a = data.agents.find((x) => x.key === agentKey);
                return a ? (
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    Registration: {a.registration}. Capability: {a.capability}. Owner: {a.owner ?? 'none recorded'}. {a.eligible ? '' : 'This agent is not eligible, so the reply will be withheld. '}Selecting an agent grants it no access. You can also type @{'{catalogue-key}'} in the text; the server resolves it.
                  </p>
                ) : null;
              })()}
            </div>
          )}
          <div>
            <label htmlFor="conv-text" className="text-xs font-semibold text-[var(--text-secondary)]">{mode === 'note' ? 'Note' : 'Question'}</label>
            <textarea
              id="conv-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') e.currentTarget.form?.requestSubmit(); }}
              rows={4}
              maxLength={MAX_TEXT + 200}
              aria-describedby="conv-count"
              className="mt-1 w-full resize-y rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm text-[var(--text-primary)] focus-visible:border-[var(--primary)] focus-visible:outline-none"
              placeholder={mode === 'note' ? 'Record context for the next reviewer…' : 'What is blocking this case, and what evidence supports it?'}
            />
            <p id="conv-count" className={`mt-1 text-right text-[11px] ${over ? 'text-[var(--status-red-fg)]' : 'text-[var(--text-muted)]'}`}>{text.length}/{MAX_TEXT} · Ctrl/Cmd+Enter to send</p>
          </div>
        </fieldset>
        {sendError && <p role="alert" className="text-xs text-[var(--status-red-fg)]">{sendError}</p>}
        {locked && (
          <p role="status" className="text-xs text-[var(--text-secondary)]">
            The last attempt had an unknown outcome. Retrying resends the exact same submission (same ID and text); it will not create a duplicate or a second model request.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={!data.canPost || sending || (!locked && (!text.trim() || over))}>
            {sending ? 'Sending…' : locked ? 'Retry same submission' : mode === 'note' ? 'Record note' : 'Ask for triage'}
          </Button>
          {locked && !sending && (
            <Button type="button" size="sm" variant="outline" onClick={() => { setFrozen(null); setSendError(''); }}>Discard submission and edit</Button>
          )}
        </div>
      </form>
    </section>
  );
}

function MessageItem({ m, caseId }: { m: ActionConversationMessage; caseId: number }) {
  const review = safeReviewHref(m.reviewHref, caseId);
  const bad = m.state === 'failed' || m.state === 'uncertain';
  return (
    <li className="space-y-2" data-testid={`message-${m.id}`}>
      <article className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--text-muted)]">
          <span className="font-semibold text-[var(--text-primary)]">{m.author}</span>
          <span className="rounded bg-[var(--surface-soft)] px-1.5 py-0.5 font-semibold">{m.mode === 'note' ? 'Human annotation, not source evidence' : 'Human triage request'}</span>
          {m.agentKey && <span className="font-mono">@{m.agentKey}</span>}
          {m.workItemId && <span>Work item #{m.workItemId}</span>}
          <time dateTime={m.createdAt} className="ml-auto">{format(new Date(m.createdAt), 'MMM d, HH:mm')}</time>
        </header>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--text-primary)]">{m.text}</p>
        {m.mode === 'note' && <p className="mt-2 text-[11px] text-[var(--text-muted)]">{STATE_LABEL[m.state]} · never sent to a model</p>}
      </article>

      {m.mode === 'triage' && (
        <article className={`ml-4 rounded-[var(--radius-lg)] border-l-[3px] border bg-[var(--surface-alt)] p-4 sm:ml-8 ${bad ? 'border-[var(--status-red)]' : 'border-[var(--border)] border-l-[var(--primary)]'}`} aria-label="Read-only AI response">
          <header className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded bg-[var(--primary-light-bg)] px-1.5 py-0.5 font-semibold text-[var(--primary)]">AI read-only response</span>
            <span className={`rounded px-1.5 py-0.5 font-semibold ${bad ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]' : m.state === 'pending' ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]' : 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]'}`} role="status">
              {m.state === 'pending' && <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden />}{STATE_LABEL[m.state]}
            </span>
            {m.outcome && <span className="font-semibold text-[var(--text-secondary)]">{OUTCOME_LABEL[m.outcome]}</span>}
            <time dateTime={m.updatedAt} className="ml-auto text-[var(--text-muted)]">{format(new Date(m.updatedAt), 'MMM d, HH:mm')}</time>
          </header>
          {m.state === 'pending' && <p className="mt-2 text-sm text-[var(--text-muted)]">Waiting for the read-only reply. This page checks again every 10 seconds.</p>}
          {m.state === 'failed' && <p className="mt-2 text-sm text-[var(--status-red-fg)]">The reply failed. Nothing was changed. Post a new question to try again.</p>}
          {m.state === 'uncertain' && <p className="mt-2 text-sm text-[var(--status-red-fg)]">The outcome is uncertain; a reply may not have been produced. Nothing was changed, and it will not be regenerated automatically.</p>}
          {m.state === 'withheld' && <p className="mt-2 text-sm text-[var(--text-secondary)]">The reply was withheld by the server and is not shown.</p>}
          {m.reply && m.state !== 'withheld' && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-[var(--text-primary)]">{m.reply}</p>}
          {m.outcome === 'proposal' && (
            <p className="mt-2 rounded bg-[var(--status-amber-bg)] px-2 py-1 text-xs font-semibold text-[var(--status-amber-fg)]">Proposal only. Not executed. Nothing has been sent, approved or changed.</p>
          )}
          {m.explanation && m.state !== 'withheld' && <Explanation e={m.explanation} caseId={caseId} id={m.id} />}
          {review && (
            <Link href={review} className="mt-3 inline-block text-xs font-semibold text-[var(--primary)] hover:underline">Review the evidence →</Link>
          )}
        </article>
      )}
    </li>
  );
}

function Explanation({ e, caseId, id }: { e: OnbCaseExplanation; caseId: number; id: number }) {
  const sources = new Map(e.sources.map((s) => [s.id, s]));
  return (
    <div className="mt-3 space-y-2">
      {e.paragraphs.map((p, i) => (
        <p key={i} className="text-sm text-[var(--text-primary)]">
          {p.kind === 'not-recorded' && <span className="mr-1 rounded bg-[var(--status-gray-bg)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--status-gray-fg)]">Not recorded</span>}
          {p.text}
          {p.sourceIds.length > 0 && (
            <span className="ml-1 text-[11px] text-[var(--text-muted)]">
              [{p.sourceIds.map((sid, k) => sources.has(sid) ? <a key={sid} href={`#src-${id}-${sid}`} className="font-semibold text-[var(--primary)] hover:underline">{k ? ', ' : ''}{sid}</a> : <span key={sid}>{k ? ', ' : ''}{sid}</span>)}]
            </span>
          )}
        </p>
      ))}
      {e.sources.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Cited sources ({e.sources.length})</p>
          {e.sources.map((s) => (
            <details key={s.id} id={`src-${id}-${s.id}`} className="group rounded border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs">
              <summary className="flex min-h-6 cursor-pointer list-none items-center gap-2 font-semibold text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]">
                <ChevronDown className="h-3 w-3 shrink-0 transition-transform group-open:rotate-180" aria-hidden />
                <span className="min-w-0 break-words">{s.title}</span>
                <span className="ml-auto shrink-0 font-normal text-[var(--text-muted)]">{s.kind}</span>
              </summary>
              <blockquote className="mt-2 whitespace-pre-wrap break-words border-l-2 border-[var(--border-strong)] pl-2 text-[var(--text-secondary)]">{s.excerpt}</blockquote>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-[var(--text-muted)]">
                {s.occurredAt && <time dateTime={s.occurredAt}>{format(new Date(s.occurredAt), 'MMM d, yyyy HH:mm')}</time>}
                <Link href={`/cases/${caseId}?tab=${s.tab}`} className="font-semibold text-[var(--primary)] hover:underline">Open in case ({s.tab})</Link>
              </div>
            </details>
          ))}
        </div>
      )}
      {e.limitations.length > 0 && (
        <ul className="list-disc pl-4 text-[11px] text-[var(--text-muted)]">{e.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
      )}
      <p className="text-[11px] text-[var(--text-muted)]">As of {format(new Date(e.asOf), 'MMM d, HH:mm')}{e.truncated ? ' · evidence truncated' : ''}</p>
    </div>
  );
}

export function ConversationCaseOpener({ onOpen }: { onOpen: (caseId: number) => void }) {
  const [value, setValue] = useState('');
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1;
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (valid) onOpen(n); }}
      className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] bg-[var(--surface)] p-6"
    >
      <h3 className="font-semibold text-[var(--text-primary)]">Open a case conversation</h3>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">Enter a case ID, or use the Conversation link on any case or work item in the queues.</p>
      <div className="mt-3 flex gap-2">
        <label htmlFor="conv-case-id" className="sr-only">Case ID</label>
        <input id="conv-case-id" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} placeholder="Case ID" className="h-9 w-40 rounded border border-[var(--border)] bg-[var(--surface)] px-2 text-sm" />
        <Button type="submit" size="sm" disabled={!valid}>Open</Button>
      </div>
    </form>
  );
}
