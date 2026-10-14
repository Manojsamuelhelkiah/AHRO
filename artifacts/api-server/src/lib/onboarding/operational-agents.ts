/**
 * Canonical identities for the operational onboarding simulation personas.
 *
 * These are product-owned labels for simulation only. They are not provider
 * registrations, external vendors, or production executors.
 */
export type OperationalAgentOrigin = "internal" | "external";

export type OperationalAgent = {
  id: string;
  name: string;
  origin: OperationalAgentOrigin;
  description: string;
  owner: string;
  capabilities: string[];
  simulated: true;
};

const CATALOG: readonly OperationalAgent[] = [
  {
    id: "documentation",
    name: "Documentation & Compliance Agent",
    origin: "internal",
    description:
      "Tracks documentation requirements, missing inputs and compliance reviews. Source verification and submission require separate authorized processes.",
    owner: "HR Ops",
    capabilities: [
      "Track documentation setup tasks",
      "Identify missing inputs",
      "Record compliance blockers",
    ],
    simulated: true,
  },
  {
    id: "access",
    name: "IT Access & Identity Agent",
    origin: "internal",
    description:
      "Tracks access requirements and identity dependencies. Account provisioning requires a confirmed identity-provider result.",
    owner: "IT / Security",
    capabilities: [
      "Track access setup tasks",
      "Record identity dependencies",
      "Record access blockers",
    ],
    simulated: true,
  },
  {
    id: "assets", name: "Assets & Workplace Agent", origin: "internal",
    description: "Tracks equipment requirements and workplace dependencies. Orders, reservations and dispatch require separate system confirmation.",
    owner: "IT / Facilities",
    capabilities: ["Track asset setup tasks", "Record workplace dependencies", "Record fulfillment blockers"],
    simulated: true,
  },
  {
    id: "payroll", name: "Payroll Setup Agent", origin: "internal",
    description: "Tracks payroll inputs and handoffs. Enrolment and payroll changes require an authorized provider result.",
    owner: "Payroll Operations",
    capabilities: ["Track payroll setup tasks", "Identify missing payroll inputs", "Record payroll handoffs"],
    simulated: true,
  },
  {
    id: "learning", name: "Learning & Manager Connect Agent", origin: "internal",
    description: "Tracks learning requirements and manager coordination. Enrolments and invitations require separate confirmation.",
    owner: "L&D / Manager",
    capabilities: ["Track learning setup tasks", "Track manager-connect dependencies", "Record readiness blockers"],
    simulated: true,
  },
] as const;

export const ONBOARDING_OPERATIONAL_AGENT_CATALOG: readonly OperationalAgent[] =
  CATALOG;

function snapshot(agent: OperationalAgent): OperationalAgent {
  return {
    ...agent,
    capabilities: [...agent.capabilities],
  };
}

/**
 * Return a response-safe snapshot of the canonical catalog.
 */
export function listOnboardingAgents(): OperationalAgent[] {
  return CATALOG.map(snapshot);
}

/**
 * Resolve only registered ids. Unknown legacy values deliberately return null
 * rather than being guessed into an internal or external identity.
 */
export function resolveOnboardingAgent(
  id: string | null | undefined,
): OperationalAgent | null {
  if (!id) return null;
  const agent = CATALOG.find((candidate) => candidate.id === id);
  return agent ? snapshot(agent) : null;
}