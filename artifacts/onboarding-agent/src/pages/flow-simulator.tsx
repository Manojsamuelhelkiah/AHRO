import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Lightbulb, RotateCcw, Shuffle } from "lucide-react";
import { Link } from "wouter";
import {
  CERTIFICATION_V1, LEARNING_NOTICE, SCENARIOS, answerTraining, continueTraining, hintTraining,
  retryTraining, startTraining, suppliedNodes, trainingOutcome,
  type Scenario, type Session, type TrainingInputs,
} from "@/lib/flow-training/certification";
import "./flow-simulator.css";

const Notice = () => <p className="fs-notice" role="note" data-testid="text-learning-notice"><strong>Learning notice. </strong>{LEARNING_NOTICE}</p>;

function Setup({ onStart }: { onStart: (inputs: TrainingInputs) => void }) {
  const [scenario, setScenario] = useState<Scenario>("straightforward");
  const [managerDecision, setManager] = useState<"approved" | "declined">("approved");
  const pick = (id: Scenario) => { setScenario(id); if (id !== "manager-exception") setManager("approved"); };
  return <div className="fs-grid two">
    <form className="fs-panel space-y-5" onSubmit={(e) => { e.preventDefault(); onStart({ scenario, managerDecision }); }}>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-base font-bold">1. Choose a situation</legend>
        {SCENARIOS.map((s) => <label key={s.id} className="fs-choice">
          <input type="radio" name="scenario" value={s.id} checked={scenario === s.id} onChange={() => pick(s.id)} data-testid={`radio-scenario-${s.id}`} />
          <span><strong className="block text-sm">{s.title}</strong><span className="text-xs text-[var(--text-secondary)]">{s.description}</span></span>
        </label>)}
      </fieldset>
      {scenario === "manager-exception" && <fieldset className="space-y-2">
        <legend className="mb-2 text-base font-bold">2. Fictional manager outcome</legend>
        {(["approved", "declined"] as const).map((d) => <label key={d} className="fs-choice">
          <input type="radio" name="manager" value={d} checked={managerDecision === d} onChange={() => setManager(d)} data-testid={`radio-manager-${d}`} />
          <span className="text-sm font-semibold capitalize">{d}</span>
        </label>)}
      </fieldset>}
      <button type="submit" className="fs-btn primary" data-testid="button-start-training">Start training</button>
    </form>
    <section className="fs-panel" aria-labelledby="fs-rules">
      <h2 id="fs-rules" className="text-base font-bold">Rules for this exercise</h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--text-secondary)]">{CERTIFICATION_V1.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <p className="mt-4 text-xs text-[var(--text-muted)]">{CERTIFICATION_V1.intent} is the only playable path. There is no timer and nothing is saved.</p>
    </section>
  </div>;
}

type MapNode = { id: string; label: string; x: number; y: number; w: number };
const POS: Record<string, { x: number; y: number; w: number }> = {
  request: { x: 10, y: 108, w: 150 }, catalogue: { x: 250, y: 16, w: 170 },
  prerequisite: { x: 250, y: 200, w: 170 }, manager: { x: 470, y: 200, w: 150 },
};
const SLOT = { x: 640, y: 108, w: 150 };

function FlowMap({ session, slotLabel, ended }: { session: Session; slotLabel: string; ended: boolean }) {
  const all = suppliedNodes(session.inputs);
  const exception = session.inputs.scenario === "manager-exception";
  const shown = all.filter((n) => n.id === "request" || (n.id === "manager" ? session.position >= 3 : session.position >= 1));
  const ids = new Set(shown.map((n) => n.id));
  const nodes: MapNode[] = shown.map((n) => ({ id: n.id, label: n.label, ...POS[n.id] }));
  const mid = (id: string, side: "l" | "r") => { const p = POS[id]; return [side === "l" ? p.x : p.x + p.w, p.y + 32] as const; };
  const slotL = [SLOT.x, SLOT.y + 32] as const;
  const edge = (a: readonly [number, number], b: readonly [number, number], ghost = false, k = "") =>
    <path key={k} className={`fs-edge${ghost ? " ghost" : ""}`} d={`M${a[0]},${a[1]} C${a[0] + 45},${a[1]} ${b[0] - 45},${b[1]} ${b[0]},${b[1]}`} />;
  const edges = [];
  if (!ids.has("catalogue")) edges.push(edge(mid("request", "r"), slotL, true, "g"));
  else {
    edges.push(edge(mid("request", "r"), mid("catalogue", "l"), false, "a"), edge(mid("request", "r"), mid("prerequisite", "l"), false, "b"), edge(mid("catalogue", "r"), slotL, !ended, "c"));
    if (exception && ids.has("manager")) edges.push(edge(mid("prerequisite", "r"), mid("manager", "l"), false, "d"), edge(mid("manager", "r"), slotL, !ended, "e"));
    else edges.push(edge(mid("prerequisite", "r"), slotL, !ended, "f"));
  }
  return <div className="fs-map-scroll" tabIndex={0} role="region" aria-label="Workflow diagram. Scroll horizontally on small screens; inspect each step using the buttons below." data-testid="region-flow-diagram"><svg className="fs-map" viewBox="0 0 800 280" role="img" aria-label={`Flow map. ${nodes.length} steps revealed. ${ended ? "Outcome reached." : "Next move missing."}`}>
    {edges}
    {nodes.map((n) => <foreignObject key={n.id} x={n.x} y={n.y} width={n.w} height={64}><div className="fs-node">{n.label}<small>{all.find((a) => a.id === n.id)?.branch ?? "Originating request"}</small></div></foreignObject>)}
    <foreignObject x={SLOT.x} y={SLOT.y} width={SLOT.w} height={64}><div className={`fs-node ${ended ? "end" : "slot"}`}>{slotLabel}<small>{ended ? "Simulated" : "Missing next move"}</small></div></foreignObject>
  </svg></div>;
}

function Play({ initial, onReplay, onChange }: { initial: Session; onReplay: () => void; onChange: () => void }) {
  const [session, setSession] = useState(initial);
  const [picked, setPicked] = useState("");
  const [inspect, setInspect] = useState("request");
  const heading = useRef<HTMLHeadingElement>(null);
  const feedbackNode = useRef<HTMLDivElement>(null);
  const outcome = trainingOutcome(session);
  const q = session.questions[session.position];
  useEffect(() => {
    if (session.feedback) feedbackNode.current?.focus();
    else heading.current?.focus();
  }, [session.position, session.feedback]);
  const nodes = useMemo(() => suppliedNodes(session.inputs), [session.inputs]);
  const revealed = nodes.filter((n) => n.id === "request" || (n.id === "manager" ? session.position >= 3 : session.position >= 1));
  const current = revealed.find((n) => n.id === inspect) ?? revealed[0];
  const fb = session.feedback;
  const hinted = q ? session.hintedQuestionIds.includes(q.id) : false;
  return <div className="space-y-4">
    <div className="fs-panel">
      <div className="flex items-center justify-between text-xs font-semibold text-[var(--text-muted)]"><span>{outcome ? "Complete" : `Checkpoint ${session.position + 1} of ${session.questions.length}`}</span><span>{session.position} resolved</span></div>
      <div className="fs-bar" aria-hidden><i style={{ transform: `scaleX(${session.position / session.questions.length})` }} /></div>
      <ol className="fs-rail" aria-label="Checkpoints">{session.questions.map((x, i) => <li key={x.id} className={`fs-pip ${i < session.position ? "done" : i === session.position ? "now" : ""}`} aria-current={i === session.position ? "step" : undefined}>
        <b>{i + 1}. {i < session.position ? "Resolved" : i === session.position ? "Current checkpoint" : "Locked"}</b>{i < session.position ? x.resolvedLabel : x.kind}</li>)}</ol>
    </div>
    <div className="fs-grid two">
      <section className="fs-panel space-y-3" aria-label="Flow map">
        <FlowMap session={session} ended={!!outcome} slotLabel={outcome ? (outcome.title.includes("hold") ? "Assignment on hold" : "Course enrolment") : ({ "next-step": "Next step?", information: "Required inputs?", role: "Responsible role?", action: "Required action?" }[q.kind])} />
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Revealed steps">{revealed.map((n) => <li key={n.id}><button type="button" className="fs-chip" aria-pressed={current?.id === n.id} onClick={() => setInspect(n.id)} data-testid={`button-node-${n.id}`}>{n.label}{current?.id === n.id && <span className="ml-auto text-xs font-bold text-[var(--fs-teal)]">Inspecting</span>}</button></li>)}</ul>
        {current && <p className="fs-inspection rounded-lg bg-[var(--fs-mint)] p-3 text-sm" data-testid="text-node-detail"><strong>{current.label}.</strong> {current.detail}. {outcome ? "Flow complete." : `You are at checkpoint ${session.position + 1}: ${q.title}`}</p>}
      </section>
      <section className="fs-panel space-y-3" aria-label="Checkpoint">
        {outcome ? <div className="space-y-3">
          <h2 ref={heading} tabIndex={-1} className="text-xl font-bold" data-testid="text-outcome-title">{outcome.title}</h2>
          <p className="text-sm leading-6">{outcome.explanation}</p>
          <p className="fs-score" data-testid="text-score">{outcome.firstTry} of {outcome.total}</p>
          <p className="text-xs text-[var(--text-muted)]">Correct on first attempt, {outcome.hints} hint{outcome.hints === 1 ? "" : "s"} used. This is learning progress only, not a judgment of any employee or a qualification.</p>
          <h3 className="text-sm font-bold">Your decisions</h3>
          <ol className="space-y-2">{session.decisions.map((d, i) => { const qq = session.questions.find((x) => x.id === d.questionId)!; return <li key={i} className="rounded-lg border border-[var(--border)] p-2 text-xs"><strong>{qq.title}</strong> {qq.choices.find((c) => c.id === d.choiceId)?.label} <span className="font-bold">({d.correct ? "correct" : "not correct"})</span><br />{d.explanation}</li>; })}</ol>
          <div className="flex flex-wrap gap-2"><button type="button" className="fs-btn primary" onClick={onReplay} data-testid="button-replay"><RotateCcw className="h-4 w-4" />Replay with same inputs</button><button type="button" className="fs-btn" onClick={onChange} data-testid="button-change-scenario"><Shuffle className="h-4 w-4" />Change scenario</button></div>
        </div> : <>
          <h2 ref={heading} tabIndex={-1} className="text-lg font-bold" data-testid="text-question-title">{q.title}</h2>
          <p className="text-sm leading-6 text-[var(--text-secondary)]">{q.context}</p>
          <fieldset className="space-y-2" disabled={!!fb}>
            <legend className="sr-only">{q.title}</legend>
            {q.choices.map((c) => { const was = fb?.choiceId === c.id; return <label key={c.id} className={`fs-choice ${was ? (fb!.correct ? "ok" : "bad") : ""}`}>
              <input type="radio" name={q.id} value={c.id} checked={picked === c.id} onChange={() => setPicked(c.id)} data-testid={`radio-choice-${c.id}`} /><span className="text-sm">{c.label}</span></label>; })}
          </fieldset>
          {hinted && <p className="rounded-lg bg-[var(--fs-amber-bg)] p-3 text-sm" data-testid="text-hint"><strong>Hint. </strong>{q.hint}</p>}
          <div aria-live="polite" role="status">{fb && <div ref={feedbackNode} tabIndex={-1} className={`fs-feedback rounded-lg p-3 text-sm ${fb.correct ? "correct" : "incorrect"}`} data-testid="text-feedback"><strong>{fb.correct ? "Correct. " : "Not quite. "}</strong>{fb.explanation}</div>}</div>
          <div className="flex flex-wrap gap-2">
            {!fb && <button type="button" className="fs-btn primary" disabled={!picked} onClick={() => { setSession(answerTraining(session, picked)); }} data-testid="button-submit-answer"><Check className="h-4 w-4" />Submit answer</button>}
            {!fb && <button type="button" className="fs-btn" disabled={hinted} onClick={() => setSession(hintTraining(session))} data-testid="button-hint"><Lightbulb className="h-4 w-4" />{hinted ? "Hint shown" : "Show hint"}</button>}
            {fb && !fb.correct && <button type="button" className="fs-btn primary" onClick={() => { setSession(retryTraining(session)); setPicked(""); }} data-testid="button-retry">Try again</button>}
            {fb?.correct && <button type="button" className="fs-btn primary" onClick={() => { setSession(continueTraining(session)); setPicked(""); }} data-testid="button-continue">Continue</button>}
          </div>
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3">
            <button type="button" className="fs-btn" onClick={onReplay} data-testid="button-reset">Reset: start a fresh session</button>
            <button type="button" className="fs-btn" onClick={onChange} data-testid="button-change-scenario">Change scenario (fresh session)</button>
          </div>
        </>}
      </section>
    </div>
  </div>;
}

export function FlowSimulatorPage() {
  const [inputs, setInputs] = useState<TrainingInputs | null>(null);
  const [run, setRun] = useState(0);
  const session = useMemo(() => (inputs ? startTraining(inputs) : null), [inputs, run]);
  const setupHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = "Flow Simulator · HRO Learning Guide";
    return () => { document.title = previous; };
  }, []);
  useEffect(() => { if (!session) setupHeading.current?.focus(); }, [session]);
  return <div className="fs-root">
    <Link href="/learning-guide" className="fs-back" data-testid="link-back-guide"><ArrowLeft className="h-4 w-4" />Back to Learning Guide</Link>
    <header className="fs-hero"><h1 ref={setupHeading} tabIndex={-1}>Flow Simulator</h1><p>Practise reasoning about workflow gates, responsibility and evidence. Pick the next move at four checkpoints and watch the map fill in. Nothing here touches real employee work.</p><p className="fs-version" data-testid="text-training-version">{CERTIFICATION_V1.intent} · Training definition v{session?.definition.version ?? CERTIFICATION_V1.version}</p></header>
    <div className="mb-4"><Notice /></div>
    {session && inputs ? <Play key={run} initial={session} onReplay={() => setRun((r) => r + 1)} onChange={() => setInputs(null)} /> : <Setup onStart={(i) => { setRun((r) => r + 1); setInputs(i); }} />}
  </div>;
}

export default FlowSimulatorPage;
