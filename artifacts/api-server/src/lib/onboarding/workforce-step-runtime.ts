/**
 * Compiles the immutable, case-scoped learning policy snapshot into human
 * tasks. This is intentionally a small policy compiler, not an orchestration
 * engine: it never calls an LMS, calendar, or messaging provider.
 */
export const WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION = "workforce-step-runtime/v1" as const;

export type WorkforceStepPermittedChannel = "portal" | "manager-led";

export type WorkforceStepEscalation = {
  at: string;
  responsibleRole: string;
  assignedTo: string | null;
};

export type WorkforceStepRuntimeTask = {
  id: string;
  label: string;
  order: number;
  responsibleRole: string;
  assignedTo: string | null;
  mandatory: boolean;
  evidenceRequired: boolean;
  nonblocking: boolean;
  prerequisites: string[];
  parallelGroup: string | null;
  permittedChannels: WorkforceStepPermittedChannel[];
  notBeforeAt: string | null;
  dueAt: string | null;
  escalation: WorkforceStepEscalation | null;
};

export type WorkforceStepRuntimeIssue = {
  code: "unsupported-selection" | "invalid-policy";
  message: string;
};

export type WorkforceStepRuntimeCompilation = {
  schemaVersion: typeof WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION;
  steps: WorkforceStepRuntimeTask[];
  issues: WorkforceStepRuntimeIssue[];
};
export type WorkforceProcessWorkstream = "intake" | "payroll" | "assets" | "learning";
export type WorkforceProcessStep = WorkforceStepRuntimeTask & {
  workstream: WorkforceProcessWorkstream;
};
export type WorkforceProcessCompilation = {
  schemaVersion: typeof WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION;
  active: boolean;
  steps: WorkforceProcessStep[];
  issues: WorkforceStepRuntimeIssue[];
};

type RecordValue = Record<string, unknown>;

const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OFFSET_MIN = -90;
const OFFSET_MAX = 180;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

/** Canonical case snapshots nest policy semantics under processPolicy. */
export function workforceRuntimeEnabled(processPolicySnapshot: Record<string, unknown>): boolean {
  const canonical = record(processPolicySnapshot.processPolicy);
  return canonical?.semanticsVersion === 2 || processPolicySnapshot.semanticsVersion === 2;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new Error(`${field} must be a non-empty string of at most 120 characters.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return text(value, field);
}

function boolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean.`);
  return value;
}

function offset(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || (value as number) < OFFSET_MIN || (value as number) > OFFSET_MAX) {
    throw new Error(`${field} must be an integer between ${OFFSET_MIN} and ${OFFSET_MAX}.`);
  }
  return value as number;
}

function anchorDate(joiningDate: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) {
    throw new Error("joiningDate must be an ISO date to compile workforce step timing.");
  }
  const value = new Date(`${joiningDate}T00:00:00.000Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== joiningDate) {
    throw new Error("joiningDate must be a valid ISO date to compile workforce step timing.");
  }
  return value;
}

function dated(anchor: Date, days: number | null): string | null {
  return days === null ? null : new Date(anchor.getTime() + days * 86_400_000).toISOString();
}

function channelList(value: unknown, field: string): WorkforceStepPermittedChannel[] {
  // There is no learning portal submission endpoint. "portal" was formerly a
  // catalog label only, so accepting it here would falsely imply an executor.
  const supported = new Set<WorkforceStepPermittedChannel>(["manager-led"]);
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.some((entry) => !supported.has(entry as WorkforceStepPermittedChannel))) {
    throw new Error(`${field} supports only manager-led. A learning portal is not connected; use the actual candidate self-upload intake path only for intake evidence.`);
  }
  return [...new Set(values as WorkforceStepPermittedChannel[])];
}

function timing(
  value: unknown,
  anchor: Date,
  inheritedDueOffset: number | null,
): Pick<WorkforceStepRuntimeTask, "notBeforeAt" | "dueAt" | "escalation"> {
  if (value === undefined) {
    return { notBeforeAt: null, dueAt: dated(anchor, inheritedDueOffset), escalation: null };
  }
  const raw = record(value);
  if (!raw) throw new Error("timing must be an object.");
  if (raw.anchor !== undefined && raw.anchor !== "joining-date") {
    throw new Error('timing.anchor supports only "joining-date"; offer-acceptance has no dated evidence anchor.');
  }
  // offsetDays is the v1 compact form and means deadline offset.
  const dueOffset = offset(raw.dueOffsetDays ?? raw.offsetDays, "timing.dueOffsetDays");
  const notBeforeOffset = offset(raw.notBeforeOffsetDays, "timing.notBeforeOffsetDays");
  if (notBeforeOffset !== null && dueOffset !== null && notBeforeOffset > dueOffset) {
    throw new Error("timing.notBeforeOffsetDays cannot be after timing.dueOffsetDays.");
  }
  const escalationRaw = raw.escalation === undefined ? null : record(raw.escalation);
  if (raw.escalation !== undefined && !escalationRaw) throw new Error("timing.escalation must be an object.");
  let escalation: WorkforceStepEscalation | null = null;
  if (escalationRaw) {
    const escalationOffset = offset(escalationRaw.offsetDays, "timing.escalation.offsetDays");
    if (escalationOffset === null) throw new Error("timing.escalation.offsetDays is required.");
    if (dueOffset !== null && escalationOffset < dueOffset) {
      throw new Error("timing.escalation.offsetDays cannot be before the task deadline.");
    }
    escalation = {
      at: dated(anchor, escalationOffset)!,
      responsibleRole: text(escalationRaw.responsibleRole, "timing.escalation.responsibleRole"),
      assignedTo: optionalText(escalationRaw.assignedTo, "timing.escalation.assignedTo"),
    };
  }
  return {
    notBeforeAt: dated(anchor, notBeforeOffset),
    dueAt: dated(anchor, dueOffset ?? inheritedDueOffset),
    escalation,
  };
}

function fallbackTask(label: string, responsibleRole: string): WorkforceStepRuntimeTask {
  return {
    id: "learning-induction",
    label,
    order: 0,
    responsibleRole,
    assignedTo: null,
    mandatory: true,
    evidenceRequired: true,
    nonblocking: false,
    prerequisites: [],
    parallelGroup: null,
    // Completion evidence is recorded by the accountable human through
    // Action Center. This is not a claim that a learning portal exists.
    permittedChannels: ["manager-led"],
    notBeforeAt: null,
    dueAt: null,
    escalation: null,
  };
}

function rootLearning(snapshot: Record<string, unknown>): unknown {
  const root = record(snapshot.processPolicy);
  return root?.learning;
}

/**
 * Supported snapshot contract:
 *
 * learning: {
 *   schemaVersion: "workforce-step-runtime/v1", // optional for the compact legacy form
 *   ownership: "role name",
 *   channel: "portal" | "manager-led",
 *   timing: { anchor: "joining-date", offsetDays: number },
 *   sequence: ["step label"], // compact ordered form
 *   steps: [{ id, label, responsibleRole?, assignedTo?, mandatory?,
 *     evidenceRequired?, nonblocking?, prerequisites?, parallelGroup?,
 *     permittedChannels?, timing?: { anchor, notBeforeOffsetDays?,
 *       dueOffsetDays?, escalation?: { offsetDays, responsibleRole, assignedTo? } } }]
 * }
 *
 * A malformed or unsupported selection becomes an explicit human policy-review
 * task. It is never silently treated as an executable integration.
 */
export function compileLearningWorkforceSteps(input: {
  processPolicySnapshot: Record<string, unknown>;
  joiningDate: string;
}): WorkforceStepRuntimeCompilation {
  const policy = rootLearning(input.processPolicySnapshot);
  if (policy === undefined) {
    return {
      schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION,
      steps: [fallbackTask("Learning induction and manager-connect confirmation", "L&D / Manager")],
      issues: [],
    };
  }
  try {
    const raw = record(policy);
    if (!raw) throw new Error("learning must be an object.");
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION) {
      throw new Error(`learning.schemaVersion "${String(raw.schemaVersion)}" is unsupported.`);
    }
    const anchor = anchorDate(input.joiningDate);
    const ownership = text(raw.ownership, "learning.ownership");
    const inheritedChannels = channelList(raw.channel, "learning.channel");
    const rootTiming = record(raw.timing);
    if (!rootTiming) throw new Error("learning.timing is required.");
    if (rootTiming.anchor !== "joining-date") {
      throw new Error('learning.timing.anchor supports only "joining-date"; offer-acceptance is unsupported until a dated acceptance event is available.');
    }
    const inheritedDueOffset = offset(rootTiming.offsetDays ?? rootTiming.dueOffsetDays, "learning.timing.offsetDays");
    if (inheritedDueOffset === null) throw new Error("learning.timing.offsetDays is required.");
    const rawSteps = raw.steps;
    const compactSequence = raw.sequence;
    const candidateSteps: RecordValue[] = Array.isArray(rawSteps)
      ? rawSteps.map((entry, index) => {
          const step = record(entry);
          if (!step) throw new Error(`learning.steps[${index}] must be an object.`);
          return step;
        })
      : Array.isArray(compactSequence)
        ? compactSequence.map((entry, index) => ({
            id: `learning-${index + 1}`,
            label: entry,
            prerequisites: index ? [`learning-${index}`] : [],
          }))
        : [];
    if (!candidateSteps.length || candidateSteps.length > 24) {
      throw new Error("learning requires 1–24 steps (or a compact sequence).");
    }
    const steps = candidateSteps.map((step, index): WorkforceStepRuntimeTask => {
      const id = text(step.id, `learning.steps[${index}].id`);
      if (!STEP_ID.test(id)) throw new Error(`learning.steps[${index}].id must match ${STEP_ID}.`);
      const prerequisites = step.prerequisites === undefined
        ? []
        : (() => {
            if (!Array.isArray(step.prerequisites) || step.prerequisites.some((entry) => typeof entry !== "string" || !STEP_ID.test(entry))) {
              throw new Error(`learning.steps[${index}].prerequisites must contain valid step ids.`);
            }
            return [...new Set(step.prerequisites)];
          })();
      const stepTiming = timing(step.timing, anchor, inheritedDueOffset);
      return {
        id,
        label: text(step.label, `learning.steps[${index}].label`),
        order: index,
        responsibleRole: step.responsibleRole === undefined
          ? ownership
          : text(step.responsibleRole, `learning.steps[${index}].responsibleRole`),
        assignedTo: optionalText(step.assignedTo, `learning.steps[${index}].assignedTo`),
        mandatory: boolean(step.mandatory, true, `learning.steps[${index}].mandatory`),
        evidenceRequired: boolean(step.evidenceRequired, true, `learning.steps[${index}].evidenceRequired`),
        nonblocking: boolean(step.nonblocking, false, `learning.steps[${index}].nonblocking`),
        prerequisites,
        parallelGroup: optionalText(step.parallelGroup, `learning.steps[${index}].parallelGroup`),
        permittedChannels: step.permittedChannels === undefined
          ? inheritedChannels
          : channelList(step.permittedChannels, `learning.steps[${index}].permittedChannels`),
        ...stepTiming,
      };
    });
    const ids = new Set(steps.map((step) => step.id));
    if (ids.size !== steps.length) throw new Error("learning step ids must be unique.");
    for (const step of steps) {
      if (step.prerequisites.some((prerequisite) => prerequisite === step.id || !ids.has(prerequisite))) {
        throw new Error(`learning step "${step.id}" references an unknown or self prerequisite.`);
      }
    }
    // Dependencies must point backward. This establishes deterministic order
    // and rejects cycles rather than guessing a scheduling order.
    const order = new Map(steps.map((step) => [step.id, step.order]));
    if (steps.some((step) => step.prerequisites.some((dependency) => order.get(dependency)! >= step.order))) {
      throw new Error("learning prerequisites must reference an earlier step; use parallelGroup for concurrent work.");
    }
    return { schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION, steps, issues: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown learning policy error.";
    return {
      schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION,
      steps: [fallbackTask("Review unsupported learning policy before induction can proceed", "L&D / Manager")],
      issues: [{
        code: /unsupported|supports only|offer-acceptance/i.test(message) ? "unsupported-selection" : "invalid-policy",
        message,
      }],
    };
  }
}

function task(
  id: string,
  label: string,
  responsibleRole: string,
  workstream: WorkforceProcessWorkstream,
  prerequisites: string[] = [],
): WorkforceProcessStep {
  return {
    ...fallbackTask(label, responsibleRole),
    id,
    responsibleRole,
    workstream,
    prerequisites,
  };
}

function issue(message: string): WorkforceStepRuntimeIssue {
  return {
    code: /unsupported|only|executor/i.test(message) ? "unsupported-selection" : "invalid-policy",
    message,
  };
}

/**
 * Compile the remaining typed workforce policy controls into evidence-gated
 * human tasks. No `executors` value is accepted as a provider integration:
 * this application has no connected laptop, badge/PPE, payroll, LMS, or
 * assisted-intake executor. A selection claiming one is visible as an
 * unsupported policy review rather than silently advertised as executable.
 */
export function compileWorkforceProcessSteps(input: {
  processPolicySnapshot: Record<string, unknown>;
  joiningDate: string;
  workerCategory: string;
}): WorkforceProcessCompilation {
  // v2 is opt-in. Existing immutable snapshots (including `{}`) retain their
  // historical simulated-operational behavior and are not silently rewritten.
  if (!workforceRuntimeEnabled(input.processPolicySnapshot)) {
    return { schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION, active: false, steps: [], issues: [] };
  }
  const learning = compileLearningWorkforceSteps(input);
  const steps: WorkforceProcessStep[] = learning.steps.map((step) => ({
    ...step,
    workstream: "learning",
  }));
  const issues = [...learning.issues];
  const root = record(input.processPolicySnapshot.processPolicy);
  if (!root) return { schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION, active: true, steps, issues };
  const owner = typeof root.ownership === "string" && root.ownership.trim()
    ? root.ownership.trim()
    : null;

  const intake = root.intake;
  if (intake !== undefined) {
    try {
      const policy = record(intake);
      if (!policy) throw new Error("intake must be an object.");
      const mode = policy.mode;
      if (mode !== "individual" && mode !== "individual-or-batch") {
        throw new Error('intake.mode supports only "individual" or "individual-or-batch".');
      }
      const channel = policy.channel;
      if (!["self-upload", "assisted", "assisted-or-self-upload", "self-upload-or-assisted"].includes(channel as string)) {
        throw new Error("intake.channel supports only self-upload and/or assisted.");
      }
      if (policy.assistedIntakeAllowed !== undefined && typeof policy.assistedIntakeAllowed !== "boolean") {
        throw new Error("intake.assistedIntakeAllowed must be boolean.");
      }
      steps.push(task(
        "intake-confirmation",
        `Confirm ${mode} intake through ${String(channel)} with evidence`,
        owner ?? "HR Ops",
        "intake",
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown intake policy error.";
      issues.push(issue(message));
      steps.push(task("intake-policy-review", "Review unsupported intake policy before intake evidence can be accepted", owner ?? "HR Ops", "intake"));
    }
  }

  // Payroll does not use an external executor. For workers in scope, the
  // configured prerequisite becomes an ordered evidence task before the
  // payroll setup confirmation task.
  if (!["contractor", "vendor"].includes(input.workerCategory)) {
    try {
      const policy = root.payroll === undefined ? {} : record(root.payroll);
      if (!policy) throw new Error("payroll must be an object.");
      const payBasis = policy.payBasis === undefined ? null : policy.payBasis;
      if (payBasis !== null && payBasis !== "salary" && payBasis !== "wage") {
        throw new Error('payroll.payBasis supports only "salary" or "wage".');
      }
      const prerequisite = policy.prerequisite === undefined
        ? "payroll input evidence"
        : text(policy.prerequisite, "payroll.prerequisite");
      steps.push(task(
        "payroll-prerequisite",
        `Verify ${prerequisite}${payBasis ? ` for ${payBasis} payroll` : ""}`,
        owner ?? "Payroll Operations",
        "payroll",
      ));
      steps.push(task(
        "payroll-setup",
        `Confirm human payroll setup${payBasis ? ` (${payBasis})` : ""}`,
        owner ?? "Payroll Operations",
        "payroll",
        ["payroll-prerequisite"],
      ));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown payroll policy error.";
      issues.push(issue(message));
      steps.push(task("payroll-policy-review", "Review unsupported payroll policy before payroll setup can proceed", owner ?? "Payroll Operations", "payroll"));
    }
  }

  const executors = root.executors;
  const executorRecord = executors === undefined ? null : record(executors);
  let executorPolicyReviewRequired = false;
  if (executors !== undefined && !executorRecord) {
    issues.push(issue("executors must be an object; no executor selection is executable."));
    executorPolicyReviewRequired = true;
  }
  if (executorRecord) {
    for (const [key, selection] of Object.entries(executorRecord)) {
      if (selection !== "human-task") {
        issues.push(issue(`executors.${key}="${String(selection)}" is unsupported: no connected executor is registered.`));
        executorPolicyReviewRequired = true;
      }
    }
  }
  const assetSelection = executorRecord?.badgePpeTools ?? executorRecord?.laptopAccess;
  const assetLabel = executorRecord?.badgePpeTools !== undefined
    ? "Confirm badge, PPE and tools release"
    : executorRecord?.laptopAccess !== undefined
      ? "Confirm laptop and access handoff"
      : "Confirm assets and workplace readiness";
  steps.push(task("assets-confirmation", assetLabel, owner ?? "IT / Facilities", "assets"));
  if (executorPolicyReviewRequired) {
    steps.push(task(
      "executor-policy-review",
      "Review unsupported executor selection before workstream completion",
      owner ?? "HR Ops",
      "assets",
      ["assets-confirmation"],
    ));
  }

  if (root.induction !== undefined) {
    if (typeof root.induction !== "string" || !["office", "hse-site", "office-and-site-as-applicable"].includes(root.induction)) {
      issues.push(issue(`induction="${String(root.induction)}" is unsupported; a human policy review is required.`));
      steps.push(task("induction-policy-review", "Review unsupported induction policy before induction can proceed", owner ?? "L&D / Manager", "learning"));
    } else {
      steps.push(task(
        "induction-confirmation",
        `Complete ${root.induction.replaceAll("-", " ")} induction confirmation`,
        owner ?? "L&D / Manager",
        "learning",
      ));
    }
  }
  return { schemaVersion: WORKFORCE_STEP_RUNTIME_SCHEMA_VERSION, active: true, steps, issues };
}

/** Candidate self-upload is a real portal path and is permitted only here. */
export function candidatePortalIntakeAllowed(input: {
  processPolicySnapshot: Record<string, unknown>;
  hiringMode?: string;
}): { allowed: boolean; message: string | null } {
  const intake = record(record(input.processPolicySnapshot.processPolicy)?.intake);
  if (!intake) return { allowed: true, message: null };
  const mode = intake.mode;
  if (mode !== "individual" && mode !== "individual-or-batch") {
    return { allowed: false, message: "Candidate portal upload is unavailable until the unsupported intake mode is reviewed." };
  }
  if (input.hiringMode === "batch" && mode !== "individual-or-batch") {
    return { allowed: false, message: "This policy permits individual intake only; candidate self-upload is not permitted for this batch case." };
  }
  if (!["self-upload", "assisted-or-self-upload", "self-upload-or-assisted"].includes(intake.channel as string)) {
    return { allowed: false, message: "This policy permits assisted intake only; candidate portal self-upload is not permitted." };
  }
  return { allowed: true, message: null };
}