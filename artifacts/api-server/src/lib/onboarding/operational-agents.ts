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
      "Internal simulation persona for tracking documentation and compliance setup work; it does not verify or submit documents.",
    owner: "HR Ops",
    capabilities: [
      "Track documentation setup tasks",
      "Identify missing inputs",
      "Record simulated compliance blockers",
    ],
    simulated: true,
  },
  {
    id: "access",
    name: "IT Access & Identity Agent",
    origin: "internal",
    description:
      "Internal simulation persona for tracking access and identity setup work; it does not provision accounts or call an identity provider.",
    owner: "IT / Security",
    capabilities: [
      "Track access setup tasks",
      "Record identity dependencies",
      "Record simulated access blockers",
    ],
    simulated: true,
  },
  {
    id: "assets",
    name: "Assets & Workplace Agent",
    origin: "internal",
    description:
      "Internal simulation persona for tracking asset and workplace setup work; it does not order, reserve, or dispatch equipment.",
    owner: "IT / Facilities",
    capabilities: [
      "Track asset setup tasks",
      "Record workplace dependencies",
      "Record simulated fulfillment blockers",
    ],
    simulated: true,
  },
  {
    id: "payroll",
    name: "Payroll Setup Agent",
    origin: "internal",
    description:
      "Internal simulation persona for tracking payroll setup work; it does not enroll a worker, change payroll, or contact a payroll provider.",
    owner: "Payroll Operations",
    capabilities: [
      "Track payroll setup tasks",
      "Identify missing payroll inputs",
      "Record simulated payroll handoffs",
    ],
    simulated: true,
  },
  {
    id: "learning",
    name: "Learning & Manager Connect Agent",
    origin: "internal",
    description:
      "Internal simulation persona for tracking learning and manager-connect work; it does not enroll people or send invitations.",
    owner: "L&D / Manager",
    capabilities: [
      "Track learning setup tasks",
      "Track manager-connect dependencies",
      "Record simulated readiness blockers",
    ],
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