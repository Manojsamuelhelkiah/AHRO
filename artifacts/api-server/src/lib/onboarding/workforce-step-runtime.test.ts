import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION,
  candidatePortalIntakeAllowed,
  compileWorkforceProcessSteps,
  compileLearningWorkforceSteps,
} from "./workforce-step-runtime";

const snapshot = (learning: Record<string, unknown>) => ({ processPolicy: { learning } });

describe("workforce step runtime", () => {
  test("compiles the compact learning policy into sequential accountable human tasks", () => {
    const result = compileLearningWorkforceSteps({
      joiningDate: "2030-06-10",
      processPolicySnapshot: snapshot({
        ownership: "L&D",
        channel: "manager-led",
        timing: { anchor: "joining-date", offsetDays: -2 },
        sequence: ["Safety induction", "Role induction"],
      }),
    });
    assert.equal(result.schemaVersion, WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.steps.map((step) => [step.id, step.prerequisites, step.dueAt]), [
      ["learning-1", [], "2030-06-08T00:00:00.000Z"],
      ["learning-2", ["learning-1"], "2030-06-08T00:00:00.000Z"],
    ]);
    assert.ok(result.steps.every((step) => step.mandatory && step.evidenceRequired && !step.nonblocking));
  });

  test("preserves per-step ownership, assignment, timing, escalation and parallelism", () => {
    const result = compileLearningWorkforceSteps({
      joiningDate: "2030-06-10",
      processPolicySnapshot: snapshot({
        schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION,
        ownership: "L&D",
        channel: "manager-led",
        timing: { anchor: "joining-date", offsetDays: -1 },
        steps: [
          { id: "safety", label: "Safety", assignedTo: "Asha", parallelGroup: "day-zero" },
          {
            id: "role-induction", label: "Role induction", responsibleRole: "Manager",
            prerequisites: ["safety"], permittedChannels: ["manager-led"],
            timing: {
              anchor: "joining-date", notBeforeOffsetDays: -1, dueOffsetDays: 1,
              escalation: { offsetDays: 2, responsibleRole: "HR", assignedTo: "Mina" },
            },
          },
        ],
      }),
    });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.steps[1], {
      id: "role-induction", label: "Role induction", order: 1, responsibleRole: "Manager",
      assignedTo: null, mandatory: true, evidenceRequired: true, nonblocking: false,
      prerequisites: ["safety"], parallelGroup: null, permittedChannels: ["manager-led"],
      notBeforeAt: "2030-06-09T00:00:00.000Z", dueAt: "2030-06-11T00:00:00.000Z",
      escalation: { at: "2030-06-12T00:00:00.000Z", responsibleRole: "HR", assignedTo: "Mina" },
    });
  });

  test("reports unsupported selections and creates a human review task instead of an executable claim", () => {
    const result = compileLearningWorkforceSteps({
      joiningDate: "2030-06-10",
      processPolicySnapshot: snapshot({
        ownership: "L&D", channel: "email", timing: { anchor: "joining-date", offsetDays: -1 },
        sequence: ["Induction"],
      }),
    });
    assert.equal(result.issues[0]?.code, "unsupported-selection");
    assert.equal(result.steps[0]?.id, "learning-induction");
    assert.match(result.steps[0]?.label ?? "", /unsupported learning policy/i);
  });

  test("compiles intake, wage prerequisites, assets, ownership and induction as evidence-gated human work", () => {
    const result = compileWorkforceProcessSteps({
      joiningDate: "2030-06-10",
      workerCategory: "employee",
      processPolicySnapshot: {
        processPolicy: {
          semanticsVersion: 2,
          ownership: "Site supervisor",
          intake: { mode: "individual-or-batch", channel: "assisted-or-self-upload" },
          payroll: { payBasis: "wage", prerequisite: "timesheet-and-payroll-details" },
          induction: "hse-site",
          executors: { badgePpeTools: "human-task", payroll: "human-task" },
          learning: {
            ownership: "L&D", channel: "manager-led",
            timing: { anchor: "joining-date", offsetDays: 0 }, sequence: ["Safety induction"],
          },
        },
      },
    });
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.steps
      .filter((step) => step.workstream !== "learning")
      .map((step) => [step.id, step.workstream, step.responsibleRole, step.prerequisites]), [
        ["intake-confirmation", "intake", "Site supervisor", []],
        ["payroll-prerequisite", "payroll", "Site supervisor", []],
        ["payroll-setup", "payroll", "Site supervisor", ["payroll-prerequisite"]],
        ["assets-confirmation", "assets", "Site supervisor", []],
      ]);
    assert.ok(result.steps.every((step) => step.mandatory && step.evidenceRequired));
  });

  test("enforces self-upload only at the real candidate portal path", () => {
    const selfUpload = candidatePortalIntakeAllowed({
      processPolicySnapshot: { processPolicy: { intake: { mode: "individual-or-batch", channel: "self-upload-or-assisted" } } },
      hiringMode: "batch",
    });
    assert.equal(selfUpload.allowed, true);
    const assistedOnly = candidatePortalIntakeAllowed({
      processPolicySnapshot: { processPolicy: { intake: { mode: "individual", channel: "assisted" } } },
    });
    assert.equal(assistedOnly.allowed, false);
    assert.match(assistedOnly.message ?? "", /assisted intake only/i);
  });
});