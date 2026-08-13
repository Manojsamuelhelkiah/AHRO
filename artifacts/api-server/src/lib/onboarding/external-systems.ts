/**
 * Simulated external-system adapters for the System Watcher agent.
 *
 * Mirrors real-world access patterns:
 *  - BGV vendors (HireRight etc.) push status via webhook when a check
 *    clears — modelled as `mode: "push"` with a scheduled simulated push.
 *  - ITSM (ServiceNow) and payroll platforms are polled on a schedule —
 *    modelled as `mode: "poll"` with a deterministic, time-based status.
 *
 * Completion times are deterministic per case (derived from the case id)
 * so demos are repeatable but cases don't all flip at the same instant.
 */

export type WatchedSystem = "bgv" | "itsm" | "payroll";

export type SystemDef = {
  key: WatchedSystem;
  label: string;
  /** How the external system reports status in the real world. */
  mode: "push" | "poll";
  /** onb_connectors row this system's health is tied to. */
  connectorKey: string;
  /** Case readiness checklist key this system is authoritative for. */
  readinessKey: string;
  /** Seconds until the simulated vendor reports completion (base). */
  completionBaseSeconds: number;
  /** Deterministic per-case jitter added to the base (seconds). */
  completionJitterSeconds: number;
  /** SLA: seconds after tracking starts before the item is "late/stuck". */
  slaSeconds: number;
  /** Rule reference used on the rules-tagged completion / SLA events. */
  completionRuleRef: string;
  slaRuleRef: string;
  externalRefPrefix: string;
};

export const WATCHED_SYSTEMS: SystemDef[] = [
  {
    key: "bgv",
    label: "Background Verification",
    mode: "push",
    connectorKey: "bgv",
    readinessKey: "documentation",
    completionBaseSeconds: 80,
    completionJitterSeconds: 25,
    slaSeconds: 300,
    completionRuleRef: "4.3 Documentation Rule 4",
    slaRuleRef: "4.7 Readiness Rule 6",
    externalRefPrefix: "BGV",
  },
  {
    key: "itsm",
    label: "ITSM Access Provisioning",
    mode: "poll",
    connectorKey: "itsm",
    readinessKey: "access",
    completionBaseSeconds: 60,
    completionJitterSeconds: 20,
    slaSeconds: 180,
    completionRuleRef: "4.4 Access Rule 2",
    slaRuleRef: "4.7 Readiness Rule 6",
    externalRefPrefix: "RITM",
  },
  {
    key: "payroll",
    label: "Payroll Setup",
    mode: "poll",
    connectorKey: "payroll",
    readinessKey: "payroll",
    completionBaseSeconds: 100,
    completionJitterSeconds: 30,
    slaSeconds: 240,
    completionRuleRef: "4.3 Documentation Rule 7",
    slaRuleRef: "4.7 Readiness Rule 6",
    externalRefPrefix: "PAY",
  },
];

export function systemDef(key: string): SystemDef | undefined {
  return WATCHED_SYSTEMS.find((s) => s.key === key);
}

/** Deterministic vendor-side completion instant for a tracked check. */
export function completionAt(
  def: SystemDef,
  requestedAt: Date,
  caseId: number,
): Date {
  const jitter = (caseId * 7 + def.key.length * 13) % (def.completionJitterSeconds + 1);
  return new Date(
    requestedAt.getTime() + (def.completionBaseSeconds + jitter) * 1000,
  );
}

/**
 * Simulated vendor API response for a polled system: what the external
 * system would report if we called its status API right now.
 */
export function simulateVendorStatus(
  def: SystemDef,
  requestedAt: Date,
  caseId: number,
  now: number,
): "in-progress" | "completed" {
  return now >= completionAt(def, requestedAt, caseId).getTime()
    ? "completed"
    : "in-progress";
}

export function makeExternalRef(def: SystemDef, caseId: number): string {
  return `${def.externalRefPrefix}-${1000 + caseId}`;
}

/**
 * Non-employee pathway (contractor/vendor): outside payroll. Shared by
 * the engine (marks payroll not-applicable) and the watcher
 * (`applicableSystems` skips the payroll tracker) so the two can never
 * disagree and strand an in-progress readiness item with no tracker.
 */
export function isNonEmployee(workerCategory: string): boolean {
  return workerCategory === "contractor" || workerCategory === "vendor";
}

/** Which systems apply to a given case profile. */
export function applicableSystems(c: {
  hireType: string;
  workerCategory: string;
}): SystemDef[] {
  return WATCHED_SYSTEMS.filter((def) => {
    // Internal moves don't run a fresh background check.
    if (def.key === "bgv" && c.hireType === "internal-transfer") return false;
    // Non-employees are outside payroll.
    if (def.key === "payroll" && isNonEmployee(c.workerCategory)) return false;
    return true;
  });
}
