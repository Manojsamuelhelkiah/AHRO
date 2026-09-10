import type {
  OnbReadinessSlaActionPolicy,
  OnbReadinessSlaApplicability,
  OnbReadinessSlaPolicy,
  OnbReadinessSlaStreamKey,
  OnbReadinessSlaStreamPolicy,
} from "@workspace/db/schema";

export type ReadinessSlaBand = "green" | "amber" | "red";
export type ReadinessSlaStreamStatus =
  | "complete"
  | "incomplete"
  | "not-applicable"
  | "needs-configuration";

export type ReadinessSlaCaseProfile = {
  hireType: string;
  workerCategory: string;
};

export type ReadinessSlaStreamResult = {
  key: OnbReadinessSlaStreamKey;
  label: string;
  weight: number;
  applicable: boolean;
  status: ReadinessSlaStreamStatus;
  includedWeight: number;
  earnedWeight: number;
  reason: string;
  completedAt: string | null;
};

export type ReadinessSlaScore = {
  score: number;
  band: ReadinessSlaBand;
  includedWeight: number;
  earnedWeight: number;
  passes: boolean;
  reason: string;
};

export type ReadinessSlaActionTiming = {
  status: "scheduled" | "needs-configuration" | "not-applicable";
  dueAt: Date | null;
  warningAt: Date | null;
  escalationAt: Date | null;
  reason: string;
};

export const READINESS_SLA_STREAMS: readonly OnbReadinessSlaStreamPolicy[] = [
  { key: "documentation", label: "Documentation", weight: 20 },
  { key: "bgv", label: "Background verification", weight: 25 },
  { key: "hris", label: "HRIS", weight: 15 },
  { key: "it-assets", label: "IT & assets", weight: 20 },
  { key: "payroll", label: "Payroll", weight: 20 },
] as const;

const DEFAULT_ACTIONS: readonly OnbReadinessSlaActionPolicy[] = [
  {
    key: "documentation",
    streamKey: "documentation",
    label: "Documents verified",
    owner: "HR Operations",
    backupEmail: null,
    enabled: true,
    mandatory: true,
    anchor: "joining",
    offsetDays: -7,
    deadlineLocalTime: "17:00",
    timezone: "Asia/Kolkata",
    calendar: "days",
    holidayDates: [],
    warnHours: 48,
    escalationAfterHours: 24,
    notifyInApp: true,
    notifyEmail: false,
  },
  {
    key: "bgv-initiation",
    streamKey: "bgv",
    label: "Background verification initiated",
    owner: "Background Verification",
    backupEmail: null,
    enabled: true,
    mandatory: true,
    anchor: "joining",
    offsetDays: -10,
    deadlineLocalTime: "17:00",
    timezone: "Asia/Kolkata",
    calendar: "days",
    holidayDates: [],
    warnHours: 48,
    escalationAfterHours: 24,
    notifyInApp: true,
    notifyEmail: false,
  },
  {
    key: "bgv-result",
    streamKey: "bgv",
    label: "Background verification result",
    owner: "Background Verification",
    backupEmail: null,
    enabled: true,
    mandatory: true,
    anchor: "joining",
    offsetDays: -2,
    deadlineLocalTime: "17:00",
    timezone: "Asia/Kolkata",
    calendar: "days",
    holidayDates: [],
    warnHours: 48,
    escalationAfterHours: 24,
    notifyInApp: true,
    notifyEmail: false,
  },
  {
    key: "hris",
    streamKey: "hris",
    label: "HRIS completion",
    owner: "HRIS",
    backupEmail: null,
    enabled: true,
    mandatory: true,
    anchor: "joining",
    offsetDays: -5,
    deadlineLocalTime: "17:00",
    timezone: "Asia/Kolkata",
    calendar: "days",
    holidayDates: [],
    warnHours: 48,
    escalationAfterHours: 24,
    notifyInApp: true,
    notifyEmail: false,
  },
  {
    key: "it-assets",
    streamKey: "it-assets",
    label: "IT and assets ready",
    owner: "IT / Facilities",
    backupEmail: null,
    enabled: true,
    mandatory: true,
    anchor: "joining",
    offsetDays: -2,
    deadlineLocalTime: "17:00",
    timezone: "Asia/Kolkata",
    calendar: "days",
    holidayDates: [],
    warnHours: 48,
    escalationAfterHours: 24,
    notifyInApp: true,
    notifyEmail: false,
  },
  {
    key: "payroll",
    streamKey: "payroll",
    label: "Payroll readiness",
    owner: "Payroll",
    backupEmail: null,
    enabled: true,
    mandatory: true,
    anchor: "payroll-cutoff",
    offsetDays: 0,
    deadlineLocalTime: "17:00",
    timezone: "Asia/Kolkata",
    calendar: "days",
    holidayDates: [],
    warnHours: 48,
    escalationAfterHours: 24,
    notifyInApp: true,
    notifyEmail: false,
  },
] as const;

export const DEFAULT_READINESS_SLA_POLICY: OnbReadinessSlaPolicy = {
  streams: READINESS_SLA_STREAMS.map((stream) => ({ ...stream })),
  actions: DEFAULT_ACTIONS.map((action) => ({ ...action })),
};

function assertFiniteInteger(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
}

export function validateReadinessSlaPolicy(input: unknown): OnbReadinessSlaPolicy {
  if (!input || typeof input !== "object") throw new Error("Readiness SLA policy is required");
  const value = input as Partial<OnbReadinessSlaPolicy>;
  if (!Array.isArray(value.streams) || value.streams.length !== READINESS_SLA_STREAMS.length) {
    throw new Error("Readiness SLA policy must contain exactly five streams");
  }
  const streams = value.streams.map((stream) => {
    if (!stream || typeof stream !== "object") throw new Error("Invalid readiness SLA stream");
    const item = stream as OnbReadinessSlaStreamPolicy;
    if (!READINESS_SLA_STREAMS.some((known) => known.key === item.key)) {
      throw new Error(`Unknown readiness SLA stream "${String(item.key)}"`);
    }
    if (!item.label?.trim()) throw new Error(`Stream "${item.key}" needs a label`);
    assertFiniteInteger(item.weight, `Weight for ${item.key}`, 0, 100);
    return { key: item.key, label: item.label.trim(), weight: item.weight };
  });
  if (new Set(streams.map((stream) => stream.key)).size !== streams.length) {
    throw new Error("Readiness SLA stream keys must be unique");
  }
  if (streams.reduce((total, stream) => total + stream.weight, 0) !== 100) {
    throw new Error("Readiness SLA stream weights must total 100");
  }
  if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 50) {
    throw new Error("Readiness SLA policy must contain between 1 and 50 actions");
  }
  const actions = value.actions.map((action) => {
    if (!action || typeof action !== "object") throw new Error("Invalid readiness SLA action");
    const item = action as OnbReadinessSlaActionPolicy;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.key)) {
      throw new Error(`Invalid readiness SLA action key "${String(item.key)}"`);
    }
    if (!streams.some((stream) => stream.key === item.streamKey)) {
      throw new Error(`Action "${item.key}" references an unknown stream`);
    }
    if (!item.label?.trim() || item.label.length > 200) {
      throw new Error(`Action "${item.key}" needs a label of 1–200 characters`);
    }
    if (!item.owner?.trim() || item.owner.length > 200) {
      throw new Error(`Action "${item.key}" needs an owner`);
    }
    if (item.backupEmail !== null && typeof item.backupEmail !== "string") {
      throw new Error(`Action "${item.key}" has an invalid backup email`);
    }
    if (!["joining", "action-start", "payroll-cutoff"].includes(item.anchor)) {
      throw new Error(`Action "${item.key}" has an invalid anchor`);
    }
    assertFiniteInteger(item.offsetDays, `Offset for ${item.key}`, -3650, 3650);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.deadlineLocalTime)) {
      throw new Error(`Action "${item.key}" needs a local deadline in HH:mm`);
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: item.timezone }).format();
    } catch {
      throw new Error(`Action "${item.key}" has an invalid IANA timezone`);
    }
    if (!["days", "businessDays"].includes(item.calendar)) {
      throw new Error(`Action "${item.key}" has an invalid calendar`);
    }
    if (!Array.isArray(item.holidayDates) || item.holidayDates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
      throw new Error(`Action "${item.key}" has invalid holiday dates`);
    }
    assertFiniteInteger(item.warnHours, `Warning hours for ${item.key}`, 0, 8760);
    assertFiniteInteger(item.escalationAfterHours, `Escalation hours for ${item.key}`, 0, 8760);
    return {
      key: item.key,
      streamKey: item.streamKey,
      label: item.label.trim(),
      owner: item.owner.trim(),
      backupEmail: item.backupEmail?.trim() || null,
      enabled: Boolean(item.enabled),
      mandatory: Boolean(item.mandatory),
      anchor: item.anchor,
      offsetDays: item.offsetDays,
      deadlineLocalTime: item.deadlineLocalTime,
      timezone: item.timezone,
      calendar: item.calendar,
      holidayDates: [...item.holidayDates],
      warnHours: item.warnHours,
      escalationAfterHours: item.escalationAfterHours,
      notifyInApp: Boolean(item.notifyInApp),
      notifyEmail: Boolean(item.notifyEmail),
    };
  });
  if (new Set(actions.map((action) => action.key)).size !== actions.length) {
    throw new Error("Readiness SLA action keys must be unique");
  }
  return { streams, actions };
}

export function defaultReadinessSlaPolicy(): OnbReadinessSlaPolicy {
  return {
    streams: DEFAULT_READINESS_SLA_POLICY.streams.map((stream) => ({ ...stream })),
    actions: DEFAULT_READINESS_SLA_POLICY.actions.map((action) => ({
      ...action,
      holidayDates: [...action.holidayDates],
    })),
  };
}

export function readinessSlaApplicability(
  profile: ReadinessSlaCaseProfile,
): OnbReadinessSlaApplicability[] {
  const nonEmployee = profile.workerCategory === "contractor" || profile.workerCategory === "vendor";
  return [
    {
      key: "documentation",
      applicable: true,
      reason: "Required documentation and safe uploads are checked for this pathway",
    },
    {
      key: "bgv",
      applicable: profile.hireType !== "internal-transfer",
      reason: profile.hireType === "internal-transfer"
        ? "Internal-transfer pathway does not run a fresh BGV check"
        : "Current tracked BGV result is required",
    },
    {
      key: "hris",
      applicable: !nonEmployee,
      reason: nonEmployee
        ? "Non-employee pathway does not require employee HRIS activation"
        : "Separate HR-attested HRIS completion is required",
    },
    {
      key: "it-assets",
      applicable: true,
      reason: "Both existing access and asset readiness are required",
    },
    {
      key: "payroll",
      applicable: !nonEmployee,
      reason: nonEmployee
        ? "Non-employee pathway is outside payroll"
        : "Existing payroll check and readiness are required",
    },
  ];
}

export function calculateReadinessSlaScore(
  streams: readonly ReadinessSlaStreamResult[],
  mandatoryIncomplete = streams.some(
    (stream) => stream.applicable && stream.status !== "complete",
  ),
): ReadinessSlaScore {
  const includedWeight = streams.reduce(
    (total, stream) => total + (stream.applicable ? stream.weight : 0),
    0,
  );
  const earnedWeight = streams.reduce(
    (total, stream) => total + (stream.applicable && stream.status === "complete" ? stream.weight : 0),
    0,
  );
  const score = includedWeight === 0 ? 100 : Math.round((earnedWeight / includedWeight) * 100);
  const band: ReadinessSlaBand = score >= 100 ? "green" : score >= 80 ? "amber" : "red";
  return {
    score,
    band,
    includedWeight,
    earnedWeight,
    passes: !mandatoryIncomplete,
    reason: mandatoryIncomplete
      ? "One or more applicable mandatory readiness streams are incomplete"
      : "Every applicable mandatory readiness stream is complete",
  };
}

export function deriveStreamResult(input: {
  key: OnbReadinessSlaStreamKey;
  label: string;
  weight: number;
  applicability: OnbReadinessSlaApplicability;
  complete: boolean;
  completedAt?: Date | string | null;
  reason: string;
}): ReadinessSlaStreamResult {
  if (!input.applicability.applicable) {
    return {
      key: input.key,
      label: input.label,
      weight: input.weight,
      applicable: false,
      status: "not-applicable",
      includedWeight: 0,
      earnedWeight: 0,
      reason: input.applicability.reason,
      completedAt: null,
    };
  }
  return {
    key: input.key,
    label: input.label,
    weight: input.weight,
    applicable: true,
    status: input.complete ? "complete" : "incomplete",
    includedWeight: input.weight,
    earnedWeight: input.complete ? input.weight : 0,
    reason: input.reason,
    completedAt: input.completedAt
      ? (input.completedAt instanceof Date ? input.completedAt.toISOString() : input.completedAt)
      : null,
  };
}

function localDateToUtc(
  date: string,
  time: string,
  timezone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const naive = Date.UTC(year!, month! - 1, day!, hour, minute);
  let candidate = naive;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (let i = 0; i < 3; i += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
    );
    candidate += naive - observed;
  }
  return new Date(candidate);
}

function dateOnlyFromDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateOnlyInTimezone(value: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addCalendarDays(date: string, count: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return dateOnlyFromDate(value);
}

function isBusinessDate(date: string, holidays: ReadonlySet<string>): boolean {
  const value = new Date(`${date}T00:00:00Z`);
  const day = value.getUTCDay();
  return day !== 0 && day !== 6 && !holidays.has(date);
}

function addBusinessDays(date: string, count: number, holidays: ReadonlySet<string>): string {
  const direction = count < 0 ? -1 : 1;
  let remaining = Math.abs(count);
  let cursor = date;
  while (remaining > 0) {
    cursor = addCalendarDays(cursor, direction);
    if (isBusinessDate(cursor, holidays)) remaining -= 1;
  }
  return cursor;
}

export function calculateReadinessSlaActionTiming(input: {
  action: OnbReadinessSlaActionPolicy;
  joiningDate: string | null;
  actionStartedAt?: Date | null;
  payrollCutoff?: Date | null;
  now?: Date;
}): ReadinessSlaActionTiming {
  let anchorDate: string;
  if (input.action.anchor === "payroll-cutoff") {
    if (!input.payrollCutoff) {
      return {
        status: "needs-configuration",
        dueAt: null,
        warningAt: null,
        escalationAt: null,
        reason: "Payroll cutoff is required; no deadline was invented",
      };
    }
    anchorDate = input.action.calendar === "businessDays"
      ? dateOnlyInTimezone(input.payrollCutoff, input.action.timezone)
      : dateOnlyFromDate(input.payrollCutoff);
  } else if (input.action.anchor === "action-start") {
    if (!input.actionStartedAt) {
      return {
        status: "needs-configuration",
        dueAt: null,
        warningAt: null,
        escalationAt: null,
        reason: "This action requires a source-recorded initiated timestamp; no fallback case timestamp was used",
      };
    }
    anchorDate = dateOnlyInTimezone(input.actionStartedAt, input.action.timezone);
  } else {
    if (!input.joiningDate) {
      return {
        status: "needs-configuration",
        dueAt: null,
        warningAt: null,
        escalationAt: null,
        reason: "This snapshot has no joining date; explicitly rebase the case before scheduling joining-date actions",
      };
    }
    anchorDate = input.joiningDate;
  }
  const holidays = new Set(input.action.holidayDates);
  // Payroll cutoffs are entered as instants. For an explicit `days` policy,
  // preserve that instant and apply the configured offset in 24-hour days;
  // never slice the Date as UTC and reconstruct it at a configured wall time.
  if (input.action.anchor === "payroll-cutoff" && input.action.calendar === "days") {
    const dueAt = new Date(
      input.payrollCutoff!.getTime() + input.action.offsetDays * 24 * 3600_000,
    );
    return {
      status: "scheduled",
      dueAt,
      warningAt: new Date(dueAt.getTime() - input.action.warnHours * 3600_000),
      escalationAt: new Date(dueAt.getTime() + input.action.escalationAfterHours * 3600_000),
      reason: `Deadline anchored to the exact payroll cutoff instant with a ${input.action.offsetDays}-day offset`,
    };
  }
  const deadlineDate = input.action.calendar === "businessDays"
    ? addBusinessDays(anchorDate, input.action.offsetDays, holidays)
    : addCalendarDays(anchorDate, input.action.offsetDays);
  const dueAt = localDateToUtc(deadlineDate, input.action.deadlineLocalTime, input.action.timezone);
  return {
    status: "scheduled",
    dueAt,
    warningAt: new Date(dueAt.getTime() - input.action.warnHours * 3600_000),
    escalationAt: new Date(
      dueAt.getTime() + input.action.escalationAfterHours * 3600_000,
    ),
    reason: `Deadline anchored to ${input.action.anchor} at ${input.action.deadlineLocalTime} ${input.action.timezone}`,
  };
}

export function actionStatusAt(
  timing: ReadinessSlaActionTiming,
  now = new Date(),
): "needs-configuration" | "scheduled" | "warning" | "breach" | "escalated" {
  if (timing.status !== "scheduled") return "needs-configuration";
  if (timing.escalationAt && now >= timing.escalationAt) return "escalated";
  if (timing.dueAt && now >= timing.dueAt) return "breach";
  if (timing.warningAt && now >= timing.warningAt) return "warning";
  return "scheduled";
}