/**
 * Browser-only teaching content. Deliberately imports no executable registry,
 * API client, domain record, model, provider, analytics or persistence code.
 * Published versions are retained and selected explicitly, never upgraded mid-session.
 */
export type Scenario = "straightforward" | "missing-prerequisite" | "manager-exception";
export type TrainingInputs = Readonly<{ scenario: Scenario; managerDecision: "approved" | "declined" }>;
export type QuestionKind = "next-step" | "role" | "action" | "information";
export type Choice = Readonly<{ id: string; label: string; correct: boolean; feedback: string }>;
export type Question = Readonly<{
  id: string; kind: QuestionKind; title: string; context: string; hint: string;
  choices: readonly Choice[]; resolvedLabel: string;
}>;
export type FlowNode = Readonly<{ id: string; label: string; detail: string; branch?: string }>;
export type TrainingDefinition = Readonly<{
  id: string; version: number; intent: string; rules: readonly string[];
}>;
export const CERTIFICATION_V1: TrainingDefinition = Object.freeze({
  id: "learning.certification-course-assignment", version: 1,
  intent: "Certification / course assignment",
  rules: Object.freeze([
    "Illustrative training rules, not the active policy of every client.",
    "Check the course catalogue and prerequisite evidence before enrolment. These checks may be considered in either order.",
    "Missing prerequisite evidence puts assignment on hold. In this exercise, it is not supplied later and cannot be waived by a manager.",
    "An exception to the normal training budget needs a human manager decision before an L&D coordinator may enrol.",
    "An agent may check supplied information and prepare a plan; it cannot approve a budget exception or attest course completion.",
    "Enrolment is not attendance, course completion, certification or professional qualification.",
  ]),
});
export const SCENARIOS: readonly Readonly<{ id: Scenario; title: string; description: string }>[] = Object.freeze([
  { id: "straightforward", title: "Straightforward assignment", description: "Prerequisite evidence is supplied. The course is within the normal training budget." },
  { id: "missing-prerequisite", title: "Missing prerequisite", description: "The course requires foundation training, but its completion evidence is missing. No budget exception is needed." },
  { id: "manager-exception", title: "Manager-approval exception", description: "Prerequisite evidence is supplied, but the course exceeds the normal training budget." },
]);
export const LEARNING_NOTICE = "Learning only. Nothing is sent, assigned or updated in operational systems. No case, Action Center item, provider call, approval receipt, execution history or operational KPI is created or changed.";

export function parseTrainingInputs(value: unknown): TrainingInputs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Select supported training conditions.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== "scenario" && key !== "managerDecision") ||
      !SCENARIOS.some(item => item.id === record.scenario) ||
      !["approved", "declined"].includes(record.managerDecision as string)) throw new Error("Unsupported training conditions.");
  if (record.scenario !== "manager-exception" && record.managerDecision !== "approved") throw new Error("Manager outcome applies only to the exception path.");
  return Object.freeze({ scenario: record.scenario as Scenario, managerDecision: record.managerDecision as TrainingInputs["managerDecision"] });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const choice = (id: string, label: string, correct: boolean, feedback: string): Choice => ({ id, label, correct, feedback });

export function trainingQuestions(inputs: TrainingInputs): readonly Question[] {
  const missing = inputs.scenario === "missing-prerequisite";
  const exception = inputs.scenario === "manager-exception";
  const held = missing || (exception && inputs.managerDecision === "declined");
  return freeze([
    {
      id: "checks", kind: "next-step", title: "What should happen next?",
      context: "A fictional requester asks to be assigned the Advanced Safety course. The course identifier, fictional learner reference and target date are supplied. No course has been assigned.",
      hint: "Two independent checks can start in either order. Neither permits enrolment on its own.",
      resolvedLabel: "Catalogue and prerequisite checks considered",
      choices: [
        choice("catalogue", "Check the course catalogue and availability", true, "Valid starting point. Catalogue availability and prerequisite evidence can be checked in parallel. The simulator supplies the other check automatically; both gates still apply."),
        choice("prerequisite", "Check the prerequisite evidence", true, "Also valid. Prerequisite evidence and catalogue availability can be checked in parallel, in either order. The simulator supplies the other check automatically; neither check bypasses a gate."),
        choice("enrol-now", "Enrol immediately", false, "Enrolment is premature: the required checks and any exception decision have not been considered."),
      ],
    },
    {
      id: "inputs", kind: "information", title: missing ? "Which required input is missing?" : exception ? "What does the exception review need?" : "What information supports the assignment?",
      context: missing ? "Supplied check: the course is available, but no foundation-course completion evidence was supplied."
        : exception ? "Supplied check: the course is available and prerequisite evidence is present. Its fee exceeds the normal training budget."
        : "Supplied check: the course is available, prerequisite evidence is present and the fee is within the normal training budget.",
      hint: missing ? "A request is not proof that a prerequisite was completed." : exception ? "Give the decision maker enough context to decide the budget exception." : "Use the supplied assignment details and the required evidence, not a claim of certification.",
      resolvedLabel: missing ? "Missing foundation evidence identified" : exception ? "Exception review information identified" : "Required assignment information identified",
      choices: [
        choice("required", missing ? "Foundation-course completion evidence" : exception ? "Course fee, budget exception reason and requested target date" : "Learner reference, course identifier, target date and prerequisite evidence", true,
          missing ? "Correct. The prerequisite is unverified. Under these training rules, assignment stays on hold until evidence is supplied and checked."
            : exception ? "Correct. The manager needs the fee, reason and requested timing to decide the exception; a learner answer is not a real approval."
            : "Correct. The supplied identifiers, timing and prerequisite evidence support assignment. They do not establish course completion."),
        choice("certificate", "An Advanced Safety certificate issued now", false, "Assignment cannot generate a certificate. Actual course completion and certification are separate later processes."),
        choice("none", "No supporting information is needed", false, "The training rules require assignment information and prerequisite evidence, plus exception context when applicable."),
      ],
    },
    {
      id: "owner", kind: "role", title: "Who owns the next responsibility?",
      context: missing ? "The foundation evidence is still absent. Someone needs to supply it before the L&D team can verify eligibility."
        : exception ? "A budget exception is needed. The next responsibility is deciding whether it may proceed, not performing enrolment."
        : "All illustrative assignment gates are satisfied. The next responsibility is course enrolment.",
      hint: missing ? "The learner supplies evidence; L&D checks it." : exception ? "A budget decision is a human responsibility." : "Separate the coordinator who enrols from the agent that assists with checks.",
      resolvedLabel: missing ? "Learner supplies evidence; L&D verifies" : exception ? "Human manager owns exception decision" : "L&D coordinator owns enrolment",
      choices: [
        choice("responsible", missing ? "Learner, with L&D verification" : exception ? "Human manager" : "L&D coordinator / training team", true,
          missing ? "Correct. The learner supplies the foundation evidence and L&D verifies it. Neither role can treat missing evidence as verified."
            : exception ? "Correct. A human manager decides this illustrative budget exception. An agent or this game cannot confer approval authority."
            : "Correct. The L&D coordinator handles enrolment after the gates. An agent may assist with checking supplied information but cannot attest completion."),
        choice("agent", "Agent independently approves and certifies", false, "An agent is not the human budget decision maker and cannot attest course completion or professional qualification."),
        choice("unrelated", "IT equipment team", false, "The IT equipment team does not own prerequisite evidence, learning-budget decisions or course enrolment in this training definition."),
      ],
    },
    {
      id: "action", kind: "action", title: "Which action fits the current gates?",
      context: missing ? "No new prerequisite evidence arrives during this exercise."
        : exception ? `Supplied fictional manager decision: ${inputs.managerDecision}. This is authored teaching content, not an approval receipt.`
        : "The course is available and the supplied prerequisite evidence passes the illustrative check. No exception is needed.",
      hint: held ? "A blocked prerequisite or declined exception prevents enrolment." : "Record the distinction between an enrolment and a completed course.",
      resolvedLabel: held ? "Assignment remains on hold" : "Simulated enrolment selected",
      choices: [
        choice("appropriate", held ? "Hold assignment and explain what is needed" : "Enrol in the course, without marking completion", true,
          missing ? "Correct. Hold for foundation evidence. A manager cannot waive this prerequisite under the authored training rules."
            : held ? "Correct. The declined budget exception means no enrolment. A revised request and fresh review would be needed outside this session."
            : "Correct. The learning outcome is a simulated enrolment only. Attendance, completion, assessment and certification have not occurred."),
        choice("certify", "Mark the course completed and issue certification", false, "Enrolment is not completion or certification. The session contains no attendance, assessment or certification evidence."),
        choice("bypass", held ? "Bypass the gate and enrol anyway" : "Ask an agent to approve professional qualification", false,
          held ? "The gate is not satisfied. Selecting an answer cannot waive a prerequisite or overturn the supplied manager decision." : "No learning-game answer grants professional qualification or execution authority."),
      ],
    },
  ]);
}

export function suppliedNodes(inputs: TrainingInputs): readonly FlowNode[] {
  return freeze([
    { id: "request", label: "Course assignment requested", detail: "Fictional learner · Advanced Safety · target date supplied" },
    { id: "catalogue", label: "Course available", detail: "Supplied catalogue check", branch: "Independent check A" },
    { id: "prerequisite", label: inputs.scenario === "missing-prerequisite" ? "Prerequisite evidence missing" : "Prerequisite evidence supplied", detail: "Supplied foundation-course evidence check", branch: "Independent check B" },
    ...(inputs.scenario === "manager-exception" ? [{ id: "manager", label: `Budget exception ${inputs.managerDecision}`, detail: "Supplied fictional human decision · no receipt created", branch: "Exception branch" }] : []),
  ]);
}
export type Decision = Readonly<{ questionId: string; choiceId: string; correct: boolean; explanation: string }>;
export type Session = Readonly<{
  definition: TrainingDefinition; inputs: TrainingInputs; questions: readonly Question[];
  position: number; decisions: readonly Decision[]; feedback: Decision | null;
  hintedQuestionIds: readonly string[];
}>;
export function startTraining(value: unknown): Session {
  const inputs = parseTrainingInputs(value);
  return freeze({ definition: CERTIFICATION_V1, inputs, questions: trainingQuestions(inputs), position: 0, decisions: [], feedback: null, hintedQuestionIds: [] });
}
function assertSession(session: Session) {
  if (session.definition !== CERTIFICATION_V1 || !Number.isSafeInteger(session.position) ||
      session.position < 0 || session.position > session.questions.length) throw new Error("Unsupported learning session.");
}
export function answerTraining(session: Session, choiceId: string): Session {
  assertSession(session);
  if (session.feedback) throw new Error("Continue or retry before answering again.");
  const question = session.questions[session.position];
  const selected = question?.choices.find(item => item.id === choiceId);
  if (!question || !selected) throw new Error("Answer is not supported at this checkpoint.");
  const decision = { questionId: question.id, choiceId, correct: selected.correct, explanation: selected.feedback };
  return freeze({ ...session, decisions: [...session.decisions, decision], feedback: decision });
}
export function continueTraining(session: Session): Session {
  assertSession(session);
  if (!session.feedback?.correct) throw new Error("A valid answer is required before continuing.");
  return freeze({ ...session, position: session.position + 1, feedback: null });
}
export function retryTraining(session: Session): Session {
  assertSession(session);
  if (!session.feedback || session.feedback.correct) throw new Error("Retry follows an incorrect answer.");
  return freeze({ ...session, feedback: null });
}
export function hintTraining(session: Session): Session {
  assertSession(session);
  const question = session.questions[session.position];
  if (!question) throw new Error("This learning session has ended.");
  return freeze({ ...session, hintedQuestionIds: [...new Set([...session.hintedQuestionIds, question.id])] });
}
export function trainingOutcome(session: Session) {
  assertSession(session);
  if (session.position !== session.questions.length) return null;
  const held = session.inputs.scenario === "missing-prerequisite" || (session.inputs.scenario === "manager-exception" && session.inputs.managerDecision === "declined");
  return Object.freeze({
    title: held ? "Simulated outcome: assignment on hold" : "Simulated outcome: course enrolment",
    explanation: session.inputs.scenario === "missing-prerequisite" ? "Foundation-course completion evidence is still missing. No enrolment occurred."
      : held ? "The fictional manager declined the budget exception. No enrolment occurred."
      : "The illustrative assignment gates are satisfied. Enrolment was selected in the game only; the course has not been completed and no certification was earned.",
    firstTry: session.questions.filter(q => session.decisions.find(d => d.questionId === q.id)?.correct).length,
    total: session.questions.length,
    hints: session.hintedQuestionIds.length,
  });
}
