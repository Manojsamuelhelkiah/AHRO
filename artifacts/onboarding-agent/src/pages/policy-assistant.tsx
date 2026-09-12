import React, { useState, useRef, useEffect } from 'react';
import { usePolicyAnswer, usePolicyExcerpt, useCreateHandoff, usePolicyScope, type PolicyApplicability } from '../hooks/use-policies';
import { Search, CheckCircle, MessageSquareWarning, ExternalLink, ShieldAlert, Loader2 } from 'lucide-react';
import { useToast } from '../hooks/use-toast';

export function PolicyAssistantPage() {
  const scope = usePolicyScope();
  const sessionScope = `${scope.organizationId ?? ''}:${scope.userId ?? ''}`;
  const activeScope = useRef(sessionScope);
  activeScope.current = sessionScope;
  const [question, setQuestion] = useState('');
  const [country, setCountry] = useState('USA');
  const [workerType, setWorkerType] = useState('Full-Time');
  const [location, setLocation] = useState('');
  const [date, setDate] = useState<string>(new Date().toISOString().split('T')[0]);
  
  const { mutate: askPolicy, isPending: isAsking, data: answerData, error: answerError } = usePolicyAnswer();
  
  const [messages, setMessages] = useState<Array<{
    role: 'user' | 'assistant';
    content: string;
    citations?: any[];
    limitation?: any;
    question?: string; // stored to hand off
    snapshot?: { date: string; country: string; workerType: string; location: string };
  }>>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Answers can expose policy excerpts. Never retain them when the signed-in
  // user or the page-pinned organization changes.
  useEffect(() => {
    setMessages([]);
  }, [sessionScope]);
  
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;

    const currentQuestion = question;
    setMessages(prev => [...prev, { role: 'user', content: currentQuestion }]);
    setQuestion('');

    askPolicy({
      question: currentQuestion,
      appliesOn: date,
      applicability: Object.fromEntries(Object.entries({ country, workerType, location }).filter(([, value]) => value.trim()))
    }, {
      onSuccess: (data) => {
        if (activeScope.current !== sessionScope) return;
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.answer || '',
          citations: data.citations,
          limitation: data.limitation,
          question: currentQuestion,
           snapshot: { date, country, workerType, location }
        }]);
      },
      onError: (err) => {
        if (activeScope.current !== sessionScope) return;
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: '',
          limitation: { code: 'error', message: err.message },
          question: currentQuestion,
          snapshot: { date, country, workerType, location }
        }]);
      }
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] max-w-4xl mx-auto">
      <div className="flex-none mb-6">
        <h1 className="text-[var(--text-3xl)] font-bold text-[var(--primary)] mb-2">HR Policy Assistant</h1>
        <p className="text-[var(--text-muted)] text-[var(--text-base)]">
          Search approved HR policies. Answers are strictly sourced from active, published documents based on the exact applicability selected below.
        </p>
      </div>

      <div className="flex-none mb-4 p-4 rounded-xl border bg-white flex flex-wrap gap-4 items-end shadow-sm">
        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)]">Applicable Country</label>
          <input list="policy-country-values" aria-label="Applicable Country"
            value={country} 
            onChange={(e) => setCountry(e.target.value)}
            placeholder="Exact policy country value, or blank"
            className="w-full h-10 px-3 rounded-lg border bg-slate-50 focus:ring-2 focus:ring-[var(--primary)] outline-none"
          />
          <datalist id="policy-country-values">
            <option value="USA">United States</option>
            <option value="GBR">United Kingdom</option>
            <option value="CAN">Canada</option>
            <option value="AUS">Australia</option>
            <option value="IND">India</option>
            <option value="SGP">Singapore</option>
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)]">Worker Type</label>
          <input list="policy-worker-values" aria-label="Worker Type"
            value={workerType} 
            onChange={(e) => setWorkerType(e.target.value)}
            placeholder="Exact policy worker type, or blank"
            className="w-full h-10 px-3 rounded-lg border bg-slate-50 focus:ring-2 focus:ring-[var(--primary)] outline-none"
          />
          <datalist id="policy-worker-values">
            <option value="Full-Time">Full-Time</option>
            <option value="Part-Time">Part-Time</option>
            <option value="Contractor">Contractor</option>
            <option value="Intern">Intern</option>
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)]">Location (optional)</label>
          <input aria-label="Location" value={location} onChange={e => setLocation(e.target.value)} placeholder="Exact policy location value" className="w-full h-10 px-3 rounded-lg border bg-slate-50 focus:ring-2 focus:ring-[var(--primary)] outline-none" />
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
          <label className="text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)]">Effective Date</label>
          <input 
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full h-10 px-3 rounded-lg border bg-slate-50 focus:ring-2 focus:ring-[var(--primary)] outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto mb-4 bg-white rounded-xl border shadow-sm p-4 md:p-6 flex flex-col gap-6">
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto opacity-70">
            <Search className="h-12 w-12 text-[var(--text-muted)] mb-4" />
            <h3 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-2">Ask a policy question</h3>
            <p className="text-[var(--text-sm)] text-[var(--text-muted)]">
              "What is the parental leave policy for full-time employees in the UK?"
            </p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <MessageBubble 
              key={i} 
              msg={msg} 
            />
          ))
        )}
        {isAsking && (
          <div className="flex items-center gap-3 text-[var(--text-muted)] text-[var(--text-sm)]">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>Searching approved policy library...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="flex-none relative">
        <input 
          type="text" 
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about HR policies..."
          disabled={isAsking}
          className="w-full h-14 pl-5 pr-14 rounded-xl border-2 border-[var(--border)] focus:border-[var(--primary)] shadow-sm text-[var(--text-base)] outline-none disabled:opacity-50 transition-colors"
        />
        <button 
          type="submit" 
          disabled={!question.trim() || isAsking}
          className="absolute right-2 top-2 bottom-2 aspect-square flex items-center justify-center rounded-lg bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] disabled:opacity-50 transition-colors"
        >
          <Search className="h-5 w-5" />
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ msg }: { msg: any }) {
  const isUser = msg.role === 'user';
  
  return (
    <div className={`flex flex-col max-w-[85%] ${isUser ? 'self-end items-end' : 'self-start items-start'}`}>
      <div className={`
        px-5 py-3.5 rounded-2xl text-[var(--text-base)] leading-relaxed shadow-sm
        ${isUser 
          ? 'bg-[var(--primary)] text-white rounded-tr-sm' 
          : 'bg-[var(--surface-soft)] text-[var(--text-primary)] rounded-tl-sm border border-[var(--border)]'}
      `}>
        {msg.content || (msg.limitation && <span className="italic opacity-80">Unable to provide an answer.</span>)}
      </div>

      {msg.limitation && msg.snapshot && (
        <LimitationCard 
          limitation={msg.limitation} 
          question={msg.question} 
          appliesOn={msg.snapshot.date} 
          applicability={Object.fromEntries(Object.entries({ country: msg.snapshot.country, workerType: msg.snapshot.workerType, location: msg.snapshot.location ?? '' }).filter(([, value]) => value.trim()))} 
        />
      )}

      {msg.citations && msg.citations.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 w-full max-w-full">
          <p className="text-[var(--text-xs)] font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
            <CheckCircle className="h-3.5 w-3.5 text-[var(--status-green)]" />
            Sourced from {msg.citations.length} Document{msg.citations.length > 1 ? 's' : ''}
          </p>
          <div className="flex flex-wrap gap-2">
            {msg.citations.map((c: any, i: number) => (
              <CitationButton key={i} citation={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LimitationCard({ limitation, question, appliesOn, applicability }: {
  limitation: { code: string; message: string };
  question: string;
  appliesOn: string;
  applicability: PolicyApplicability;
}) {
  const { mutate: requestHandoff, isPending } = useCreateHandoff();
  const { toast } = useToast();
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState('');

  const handleHandoff = () => {
    // Preserve the originating question and its date/applicability snapshot,
    // rather than the values currently selected in the composer.
    requestHandoff({ question, appliesOn, applicability }, {
      onSuccess: (result) => {
        setRequested(true);
        setNotice(result.deduplicated ? 'An identical internal request already exists.' : 'Internal clarification request recorded. No external message was sent.');
        toast({ title: result.deduplicated ? 'Existing clarification request' : 'Clarification requested', description: 'Available in the HR Policy Library clarification queue. No external message was sent.' });
      },
      onError: (error) => {
        setNotice(error.message);
      }
    });
  };

  return (
    <div className="mt-3 p-4 rounded-xl border border-amber-200 bg-amber-50 w-full">
      <div className="flex items-start gap-3 text-amber-900">
        <ShieldAlert className="h-5 w-5 shrink-0 mt-0.5" />
        <div className="flex flex-col gap-2">
          <p className="font-semibold text-sm">Policy Limitation: {limitation.code}</p>
          <p className="text-sm opacity-90">{limitation.message}</p>
          {!requested ? (
             <button
               type="button"
              onClick={handleHandoff}
              disabled={isPending}
              className="mt-1 self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-800 text-xs font-bold hover:bg-amber-100 transition-colors disabled:opacity-50"
            >
              <MessageSquareWarning className="h-3.5 w-3.5" />
              Request Human Clarification
            </button>
          ) : (
            <p className="text-xs font-bold text-amber-700 mt-1 flex items-center gap-1.5">
              <CheckCircle className="h-3.5 w-3.5" /> Internal request recorded
            </p>
          )}
          {notice && <p role="status" className="text-xs">{notice}</p>}
        </div>
      </div>
    </div>
  );
}

function CitationButton({ citation }: { citation: any }) {
  const [open, setOpen] = useState(false);
  
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-white hover:bg-slate-50 text-[var(--text-xs)] font-medium text-[var(--text-secondary)] shadow-sm transition-colors"
      >
        <ExternalLink className="h-3.5 w-3.5 text-[var(--primary)]" />
        <span className="truncate max-w-[200px]">{citation.sourceReference} (v{citation.version})</span>
      </button>

      {open && (
        <CitationDialog citation={citation} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

function CitationDialog({ citation, onClose }: { citation: any; onClose: () => void }) {
  const { data, isLoading, error } = usePolicyExcerpt(citation.policyId, citation.version, citation.excerptId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        <div className="px-6 py-4 border-b flex items-center justify-between bg-[var(--surface-soft)]">
          <div>
            <h3 className="font-bold text-[var(--text-lg)]">{citation.sourceReference}</h3>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-0.5">Version {citation.version} • Effective {citation.effectiveFrom}</p>
          </div>
          <button aria-label="Close source excerpt" onClick={onClose} className="p-2 -mr-2 rounded-lg hover:bg-slate-200 text-slate-500">
            ✕
          </button>
        </div>
        
        <div className="p-6 overflow-y-auto flex-1 text-[var(--text-base)] leading-relaxed">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-[var(--text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin mr-2" /> Loading excerpt...
            </div>
          ) : error ? (
            <div className="p-4 rounded-xl border border-red-200 bg-red-50 text-red-700 text-sm">
              Failed to load excerpt. You may not have permission to view this historical policy version.
            </div>
          ) : (
            <>
              {data?.isCurrent === false && <p role="status" className="mb-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">Historical source — not current guidance.</p>}
              <div className="whitespace-pre-wrap font-serif text-slate-800 bg-slate-50 p-6 rounded-xl border border-slate-100">
                {data?.text ? `"${data.text}"` : 'No authorized excerpt available.'}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
