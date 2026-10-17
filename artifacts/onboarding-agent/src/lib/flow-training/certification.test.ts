import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CERTIFICATION_V1, SCENARIOS, LEARNING_NOTICE,
  startTraining, answerTraining, continueTraining, retryTraining, hintTraining,
  suppliedNodes, trainingOutcome, parseTrainingInputs,
  type TrainingInputs, type Session,
} from "./certification";

const paths: TrainingInputs[] = [
  { scenario: "straightforward", managerDecision: "approved" },
  { scenario: "missing-prerequisite", managerDecision: "approved" },
  { scenario: "manager-exception", managerDecision: "approved" },
  { scenario: "manager-exception", managerDecision: "declined" },
];
function complete(inputs: TrainingInputs, firstChoice = "catalogue") {
  let session = startTraining(inputs);
  while (session.position < session.questions.length) {
    const question = session.questions[session.position];
    const answer = session.position === 0 ? firstChoice : question.choices.find(c => c.correct)!.id;
    session = continueTraining(answerTraining(session, answer));
  }
  return session;
}

test("every supported path deterministically ends with the correct held or enrolment outcome", () => {
  assert.equal(SCENARIOS.length, 3);
  for (const inputs of paths) {
    const first = complete(inputs), second = complete(inputs);
    assert.deepEqual(first, second);
    assert.equal(first.definition, CERTIFICATION_V1);
    assert.deepEqual(first.inputs, inputs);
    assert.equal(first.definition.version, 1);
    assert.equal(first.definition.id, "learning.certification-course-assignment");
    const outcome = trainingOutcome(first)!;
    const held = inputs.scenario === "missing-prerequisite" || inputs.managerDecision === "declined";
    assert.equal(outcome.title, held ? "Simulated outcome: assignment on hold" : "Simulated outcome: course enrolment");
    assert.equal(outcome.firstTry, 4);
    assert.equal(outcome.total, 4);
    assert.equal(outcome.hints, 0);
    assert.match(outcome.explanation, held ? /No enrolment occurred/ : /no certification was earned/);
    assert.deepEqual(new Set(first.questions.map(q => q.kind)), new Set(["next-step", "role", "action", "information"]));
  }
});

test("explicit parallel-check alternatives are both valid and lead to the same subsequent gates", () => {
  for (const inputs of paths) {
    const catalogue = complete(inputs, "catalogue");
    const prerequisite = complete(inputs, "prerequisite");
    assert.notEqual(catalogue.decisions[0].choiceId, prerequisite.decisions[0].choiceId);
    assert.match(catalogue.decisions[0].explanation, /parallel/);
    assert.match(prerequisite.decisions[0].explanation, /either order/);
    assert.deepEqual(catalogue.decisions.slice(1), prerequisite.decisions.slice(1));
    assert.deepEqual(trainingOutcome(catalogue), trainingOutcome(prerequisite));
  }
});

test("all incorrect choices retain the checkpoint, explain consequences, allow hints and retry", () => {
  for (const inputs of paths) {
    let session = startTraining(inputs);
    for (const question of session.questions) {
      assert.equal(session.questions[session.position].id, question.id);
      assert.equal(trainingOutcome(session), null);
      for (const wrong of question.choices.filter(c => !c.correct)) {
        const previous = session;
        session = answerTraining(session, wrong.id);
        assert.equal(session.position, previous.position);
        assert.equal(session.feedback?.correct, false);
        assert.equal(session.feedback?.explanation, wrong.feedback);
        assert.ok(wrong.feedback.length > 30);
        assert.throws(() => continueTraining(session), /valid answer/);
        assert.throws(() => answerTraining(session, "required"), /Continue or retry/);
        const hinted = hintTraining(session);
        assert.equal(hinted.hintedQuestionIds.filter(id => id === question.id).length, 1);
        assert.deepEqual(hintTraining(hinted), hinted);
        session = retryTraining(hinted);
        assert.equal(session.feedback, null);
        assert.ok(session.decisions.includes(previous.decisions[0]) || previous.decisions.length === 0);
      }
      session = answerTraining(session, question.choices.find(c => c.correct)!.id);
      assert.throws(() => retryTraining(session), /incorrect answer/);
      session = continueTraining(session);
    }
    assert.equal(trainingOutcome(session)?.firstTry, 0);
    assert.equal(trainingOutcome(session)?.hints, 4);
    assert.equal(session.decisions.length, session.questions.reduce((total, q) => total + q.choices.filter(c => !c.correct).length + 1, 0));
  }
});

test("invalid scenario inputs are rejected rather than silently selecting a path", () => {
  for (const input of [
    null, undefined, [], "straightforward", {}, { scenario: "other", managerDecision: "approved" },
    { scenario: "straightforward" }, { scenario: "manager-exception", managerDecision: "pending" },
    { scenario: "straightforward", managerDecision: "declined" },
    { scenario: "missing-prerequisite", managerDecision: "declined" },
    { ...paths[0], employeeId: 9 }, { ...paths[0], definitionVersion: 999 },
  ]) {
    assert.throws(() => parseTrainingInputs(input));
    assert.throws(() => startTraining(input));
  }
});

test("invalid moves and terminal answers cannot progress a session or change its version", () => {
  const session = startTraining(paths[0]);
  for (const invalid of ["", "required", "not-a-choice", "__proto__"]) {
    assert.throws(() => answerTraining(session, invalid), /not supported/);
  }
  assert.throws(() => continueTraining(session), /valid answer/);
  assert.throws(() => retryTraining(session), /incorrect answer/);
  const ended = complete(paths[0]);
  assert.throws(() => answerTraining(ended, "appropriate"), /not supported/);
  assert.throws(() => hintTraining(ended), /ended/);
  assert.throws(() => continueTraining(ended), /valid answer/);
  const unsupported = { ...session, definition: { ...session.definition, version: 2 } } as Session;
  assert.throws(() => answerTraining(unsupported, "catalogue"), /Unsupported learning session/);
});

test("restart and scenario changes produce independent immutable sessions with no prior score or feedback", () => {
  const original = startTraining(paths[0]);
  const progressed = hintTraining(answerTraining(original, "enrol-now"));
  const replay = startTraining(progressed.inputs);
  const changed = startTraining(paths[1]);
  for (const fresh of [replay, changed]) {
    assert.equal(fresh.position, 0);
    assert.equal(fresh.feedback, null);
    assert.deepEqual(fresh.decisions, []);
    assert.deepEqual(fresh.hintedQuestionIds, []);
    assert.equal(fresh.definition, CERTIFICATION_V1);
  }
  assert.deepEqual(replay, original);
  assert.notDeepEqual(changed.inputs, original.inputs);
  assert.notDeepEqual(changed.questions, original.questions);
  assert.ok(Object.isFrozen(original));
  assert.ok(Object.isFrozen(original.inputs));
  assert.ok(Object.isFrozen(original.questions[0].choices[0]));
  assert.throws(() => { (original.inputs as { scenario: string }).scenario = "manager-exception"; });
  assert.equal(original.position, 0);
  assert.deepEqual(original.decisions, []);
});

test("supplied map content reflects each authored branch and remains separate from certification", () => {
  for (const inputs of paths) {
    const nodes = suppliedNodes(inputs);
    assert.equal(nodes[0].id, "request");
    assert.equal(nodes.find(n => n.id === "catalogue")?.branch, "Independent check A");
    assert.equal(nodes.find(n => n.id === "prerequisite")?.branch, "Independent check B");
    assert.match(nodes.find(n => n.id === "prerequisite")!.label, inputs.scenario === "missing-prerequisite" ? /missing/ : /supplied/);
    assert.equal(nodes.some(n => n.id === "manager"), inputs.scenario === "manager-exception");
    if (inputs.scenario === "manager-exception") assert.match(nodes.find(n => n.id === "manager")!.label, new RegExp(inputs.managerDecision));
  }
  assert.match(LEARNING_NOTICE, /Nothing is sent, assigned or updated/);
  assert.match(CERTIFICATION_V1.rules.join(" "), /not the active policy of every client/);
  assert.match(CERTIFICATION_V1.rules.join(" "), /Enrolment is not attendance/);
});

test("learning engine and simulator sources have no operational, remote or persistence capabilities", () => {
  // This source-boundary assertion complements browser network observation.
  // Keep training imports isolated rather than relying on an operational 'dry run'.
  const root = existsSync(resolve(process.cwd(), "src/lib/flow-training"))
    ? resolve(process.cwd(), "src") : resolve(process.cwd(), "artifacts/onboarding-agent/src");
  const files: string[] = [];
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(path);
    }
  }
  collect(resolve(root, "lib/flow-training"));
  files.push(resolve(root, "pages/flow-simulator.tsx"));
  // Include any simulator-specific supporting components, irrespective of nesting.
  function collectSimulator(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) collectSimulator(path);
      else if (/flow-simulator.*\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) files.push(path);
    }
  }
  collectSimulator(resolve(root, "components"));
  for (const file of new Set(files)) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()["'][^"']*(?:api-client|api-server|api-zod|@workspace\/db|flow-manager|analytics|use-control-tower)/, file);
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b\s*[.(]/, file);
  }
  const app = readFileSync(resolve(root, "App.tsx"), "utf8");
  assert.match(app, /<Protected><FlowSimulatorPage\s*\/><\/Protected>/);
});
