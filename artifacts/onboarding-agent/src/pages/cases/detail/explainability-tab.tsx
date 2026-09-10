import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { customFetch, getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { cn, Button } from '@/components/ui-shared';
import { Send, FileText, AlertCircle, Info, RefreshCw, Trash2, ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react';

export interface OnbCaseExplanationInput {
  question: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface OnbCaseExplanation {
  asOf: string;
  paragraphs: Array<{
    text: string;
    sourceIds: string[];
    kind: "supported" | "not-recorded";
  }>;
  sources: Array<{
    id: string;
    kind: string;
    title: string;
    excerpt: string;
    occurredAt: string | null;
    tab: "overview" | "activity" | "communications" | "documents" | "approvals";
  }>;
  limitations: string[];
  truncated: boolean;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  explanation?: OnbCaseExplanation;
  error?: string;
  isPending?: boolean;
}

// In-memory store that survives tab switching
const sessionStore = new Map<string, ChatMessage[]>();

// Keep track of the active scope (tenant + user) to wipe cross-tenant/user memory completely
let activeSessionScope: string | null = null;
export const getActiveSessionScope = () => activeSessionScope;

// Temporary hook pending backend codegen
export const useExplainOnboardingCase = (options?: { request?: RequestInit }) => {
  return useMutation({
    mutationFn: async ({ id, data, signal }: { id: number; data: OnbCaseExplanationInput; signal?: AbortSignal }) => {
      return customFetch<OnbCaseExplanation>(`/api/onboarding/cases/${id}/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: signal || options?.request?.signal
      });
    },
  });
};

export function ExplainabilityTab({ caseId, userId }: { caseId: number, userId?: string }) {
  const orgId = getPinnedOrganizationIdForPage() || 'anon-org';
  const currentScope = `${orgId}-${userId || 'anon'}`;
  const sessionKey = `${currentScope}-${caseId}`;

  // Wipe memory if auth/tenant changes
  if (activeSessionScope !== null && activeSessionScope !== currentScope) {
    sessionStore.clear();
  }
  activeSessionScope = currentScope;
  
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    return sessionStore.get(sessionKey) || [];
  });
  
  // Reset state properly when session key changes
  const currentSessionKeyRef = useRef(sessionKey);
  if (currentSessionKeyRef.current !== sessionKey) {
    currentSessionKeyRef.current = sessionKey;
    const initialMessages = sessionStore.get(sessionKey) || [];
    setMessages(initialMessages);
  }

  const [input, setInput] = useState('');
  
  const queryClient = useQueryClient();
  const explainCase = useExplainOnboardingCase();
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Abort on unmount/scope change
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
    sessionStore.set(sessionKey, messages);
  }, [messages, sessionKey]);

  const handleSubmit = (e?: React.FormEvent, retryId?: string) => {
    e?.preventDefault();
    
    let targetQuestion = input.trim();
    let updatedMessages = [...messages];
    
    if (retryId) {
      const msg = updatedMessages.find(m => m.id === retryId);
      if (msg && msg.role === 'user') {
        targetQuestion = msg.content;
        // Remove this message and any subsequent messages to retry from this point
        const idx = updatedMessages.findIndex(m => m.id === retryId);
        updatedMessages = updatedMessages.slice(0, idx);
      }
    } else {
      if (!targetQuestion || explainCase.isPending) return;
      setInput('');
    }

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();
    
    const newMessages: ChatMessage[] = [
      ...updatedMessages,
      { id: userMsgId, role: 'user', content: targetQuestion },
      { id: assistantMsgId, role: 'assistant', content: '', isPending: true }
    ];
    
    setMessages(newMessages);
    
    // Abort previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    // Build history (max 8 messages, limit size if needed)
    const history = updatedMessages
      .filter(m => !m.error && !m.isPending && m.content)
      .slice(-8)
      .map(m => ({
        role: m.role,
        content: m.role === 'assistant' && m.explanation ? m.explanation.paragraphs.map(p => p.text).join('\n\n') : m.content
      }));

    explainCase.mutate(
      { id: caseId, data: { question: targetQuestion, history }, signal: abortControllerRef.current.signal },
      {
        onSuccess: (data) => {
          if (currentSessionKeyRef.current !== sessionKey) return; // Ignore stale response
          
          setMessages(prev => {
            if (!prev.some(m => m.id === assistantMsgId)) return prev; // Was cleared
            return prev.map(m => m.id === assistantMsgId ? { ...m, isPending: false, explanation: data } : m)
          });
          // Focus input after reply
          setTimeout(() => inputRef.current?.focus(), 50);
        },
        onError: (error: any) => {
          if (currentSessionKeyRef.current !== sessionKey) return;
          if (error?.name === 'AbortError') return;
          
          setMessages(prev => {
            if (!prev.some(m => m.id === assistantMsgId)) return prev;
            return prev.map(m => m.id === assistantMsgId ? { 
              ...m, 
              isPending: false, 
              error: error?.message || 'Failed to analyze case. Please try again.' 
            } : m)
          });
        }
      }
    );
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleClear = () => {
    if (window.confirm('Clear conversation history?')) {
      setMessages([]);
      sessionStore.delete(sessionKey);
    }
  };

  const handleSuggest = (q: string) => {
    setInput(q);
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-280px)] min-h-[500px] max-w-4xl bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[var(--border)] bg-[var(--surface-alt)]">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[var(--primary-light-bg)] flex items-center justify-center text-[var(--primary)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>
          </div>
          <div>
            <h3 className="text-[var(--text-base)] font-bold text-[var(--text-primary)]">Case Analysis</h3>
            <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">Ask questions about this specific case. Information is retrieved from case records.</p>
          </div>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" onClick={handleClear} className="text-[var(--text-muted)] hover:text-[var(--status-red)]">
            <Trash2 className="w-4 h-4 mr-2" /> Clear
          </Button>
        )}
      </div>

      {/* Notice */}
      <div className="bg-[var(--surface-soft)] px-4 py-2 border-b border-[var(--border)] text-[var(--text-xs)] text-[var(--text-secondary)] flex items-start gap-2">
        <Info className="w-4 h-4 text-[var(--primary)] shrink-0 mt-0.5" />
        <p>AI-generated explanation—check cited records. Claims are backed by source references, but facts are not guaranteed to be verified. Click references to inspect context.</p>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center max-w-md mx-auto space-y-6">
            <div className="w-16 h-16 rounded-2xl bg-[var(--primary-light-bg)] flex items-center justify-center text-[var(--primary)] shadow-sm">
              <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>
            </div>
            <div>
              <h4 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-2">What would you like to know?</h4>
              <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">I can summarize case status, review communications, or check background screening results.</p>
            </div>
            <div className="w-full flex flex-col gap-2">
              <button onClick={() => handleSuggest('What is currently blocking this case?')} className="text-left px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] hover:border-[var(--primary)] text-[var(--text-sm)] text-[var(--text-primary)] transition-all">
                What is currently blocking this case?
              </button>
              <button onClick={() => handleSuggest('Summarize recent communications with the candidate.')} className="text-left px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] hover:border-[var(--primary)] text-[var(--text-sm)] text-[var(--text-primary)] transition-all">
                Summarize recent communications with the candidate.
              </button>
              <button onClick={() => handleSuggest('Are all background checks completed successfully?')} className="text-left px-4 py-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-alt)] hover:border-[var(--primary)] text-[var(--text-sm)] text-[var(--text-primary)] transition-all">
                Are all background checks completed successfully?
              </button>
            </div>
          </div>
        ) : (
          messages.map((msg, index) => (
            <div key={msg.id} className={cn("flex gap-4 max-w-3xl", msg.role === 'user' ? "ml-auto flex-row-reverse" : "")}>
              {/* Avatar */}
              <div className={cn("w-8 h-8 rounded-full flex items-center justify-center shrink-0", 
                msg.role === 'user' ? "bg-[var(--text-primary)] text-[var(--surface)]" : "bg-[var(--primary-light-bg)] text-[var(--primary)]"
              )}>
                {msg.role === 'user' ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>
                )}
              </div>

              {/* Content */}
              <div className={cn("flex flex-col gap-1 min-w-0", msg.role === 'user' ? "items-end" : "items-start")}>
                {msg.role === 'user' ? (
                  <div className="bg-[var(--text-primary)] text-[var(--surface)] px-4 py-2.5 rounded-[var(--radius-lg)] rounded-tr-sm text-[var(--text-sm)] whitespace-pre-wrap shadow-sm">
                    {msg.content}
                  </div>
                ) : msg.isPending ? (
                  <div className="bg-[var(--surface-alt)] border border-[var(--border)] px-4 py-3 rounded-[var(--radius-lg)] rounded-tl-sm text-[var(--text-sm)] w-full shadow-sm flex gap-2 items-center text-[var(--text-muted)]">
                    <span className="flex gap-1">
                      <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                      <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                      <span className="w-1.5 h-1.5 bg-[var(--text-muted)] rounded-full animate-bounce"></span>
                    </span>
                    Analyzing case context...
                  </div>
                ) : msg.error ? (
                  <div className="bg-[var(--status-red-bg)] border border-[var(--status-red)] text-[var(--status-red-fg)] px-4 py-3 rounded-[var(--radius-lg)] rounded-tl-sm text-[var(--text-sm)] w-full shadow-sm">
                    <div className="flex items-center gap-2 mb-2 font-bold">
                      <AlertCircle className="w-4 h-4" />
                      An error occurred
                    </div>
                    <p className="mb-3">{msg.error}</p>
                    <Button variant="outline" size="sm" onClick={() => handleSubmit(undefined, messages[index - 1]?.id)} className="h-7 text-[11px] gap-1.5 bg-[var(--surface)] text-[var(--text-primary)]">
                      <RefreshCw className="w-3 h-3" /> Retry Analysis
                    </Button>
                  </div>
                ) : msg.explanation ? (
                  <div className="bg-[var(--surface)] border border-[var(--border)] p-4 rounded-[var(--radius-lg)] rounded-tl-sm text-[var(--text-sm)] w-full shadow-sm space-y-4">
                    {/* Paragraphs */}
                    <div className="space-y-3 text-[var(--text-primary)] leading-relaxed">
                      {msg.explanation.paragraphs.map((p, i) => (
                        <p key={i}>
                          {p.text}
                          {p.kind === 'not-recorded' && (
                            <span className="inline-flex items-center gap-1 ml-2 text-[10px] uppercase font-bold tracking-wider text-[var(--status-amber)] bg-[var(--status-amber-bg)] px-1.5 py-0.5 rounded">
                              Not recorded
                            </span>
                          )}
                          {p.sourceIds.length > 0 && (
                            <span className="inline-flex gap-1 ml-1">
                              {p.sourceIds.map((sid, sidx) => {
                                const sourceIdx = msg.explanation!.sources.findIndex(s => s.id === sid);
                                return (
                                  <sup key={sid} className="text-[10px] font-bold text-[var(--primary)] hover:underline cursor-pointer select-none">
                                    [{sourceIdx !== -1 ? sourceIdx + 1 : '?'}]
                                  </sup>
                                );
                              })}
                            </span>
                          )}
                        </p>
                      ))}
                    </div>

                    {/* Sources Expandable */}
                    {msg.explanation.sources.length > 0 && (
                      <div className="mt-4 pt-4 border-t border-[var(--border)]">
                        <details className="group">
                          <summary className="flex items-center gap-2 cursor-pointer text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium text-[11px] uppercase tracking-wider select-none list-none [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="w-3.5 h-3.5 group-open:rotate-90 transition-transform" />
                            Sources ({msg.explanation.sources.length})
                          </summary>
                          <div className="mt-3 space-y-3">
                            {msg.explanation.sources.map((src, i) => (
                              <div key={src.id} className="bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] border border-[var(--border)] flex gap-3 text-[var(--text-xs)]">
                                <div className="font-mono text-[var(--primary)] font-bold mt-0.5 shrink-0">[{i + 1}]</div>
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                                    <span className="font-bold text-[var(--text-primary)]">{src.title}</span>
                                    <span className="px-1.5 py-0.5 bg-[var(--surface)] rounded border border-[var(--border)] text-[9px] uppercase tracking-wider text-[var(--text-muted)] font-mono">{src.kind}</span>
                                    {src.occurredAt && <span className="text-[10px] text-[var(--text-muted)]">{new Date(src.occurredAt).toLocaleString()}</span>}
                                  </div>
                                  <p className="text-[var(--text-secondary)] italic border-l-2 border-[var(--border-strong)] pl-2 py-0.5 my-1.5 whitespace-pre-wrap bg-[var(--surface)] pr-2 rounded-r-sm">"{src.excerpt}"</p>
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      </div>
                    )}

                    {/* Limitations & Metadata */}
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-4 pt-3 border-t border-[var(--border-soft)] text-[10px] text-[var(--text-muted)]">
                      <span>Analyzed as of {new Date(msg.explanation.asOf).toLocaleTimeString()}</span>
                      {msg.explanation.truncated && (
                        <span className="flex items-center gap-1 text-[var(--status-amber)]"><AlertCircle className="w-3 h-3" /> Context truncated</span>
                      )}
                      {msg.explanation.limitations.length > 0 && (
                        <details className="group relative">
                          <summary className="flex items-center gap-1 cursor-pointer hover:text-[var(--text-primary)] list-none [&::-webkit-details-marker]:hidden">
                            <Info className="w-3 h-3" /> Limitations ({msg.explanation.limitations.length})
                          </summary>
                          <div className="absolute bottom-full left-0 mb-2 w-64 bg-[var(--surface)] border border-[var(--border)] shadow-lg rounded-[var(--radius-md)] p-3 hidden group-open:block z-10">
                            <ul className="list-disc pl-4 space-y-1 text-[var(--text-secondary)]">
                              {msg.explanation.limitations.map((lim, i) => <li key={i}>{lim}</li>)}
                            </ul>
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Input */}
      <div className="p-4 bg-[var(--surface)] border-t border-[var(--border)] shrink-0">
        <form onSubmit={(e) => handleSubmit(e)} className="relative flex items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about case status, communications, or records... (Shift+Enter for newline)"
            className="w-full bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-lg)] pl-4 pr-12 py-3 text-[var(--text-sm)] resize-none focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] min-h-[50px] max-h-[150px]"
            rows={input.split('\n').length > 1 ? Math.min(input.split('\n').length, 5) : 1}
            disabled={explainCase.isPending}
          />
          <Button 
            type="submit" 
            size="icon"
            disabled={!input.trim() || explainCase.isPending}
            className="absolute right-2 bottom-2 h-8 w-8 rounded-[var(--radius-md)] bg-[var(--primary)] hover:bg-[var(--primary-dark)] text-white disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
          </Button>
        </form>
        <div className="flex justify-between items-center mt-2 px-1">
          <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
            <CornerDownRight className="w-3 h-3" /> Press Enter to send, Shift+Enter for newline
          </p>
        </div>
      </div>
    </div>
  );
}