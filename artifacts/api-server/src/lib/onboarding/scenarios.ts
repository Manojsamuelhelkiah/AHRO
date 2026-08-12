export type ScenarioDef = {
  key: string;
  title: string;
  description: string;
  specRef: string;
  expectedBehaviour: string;
  intake: {
    workerName: string;
    workerEmail: string;
    workerPhone: string | null;
    hireType: string;
    workerCategory: string;
    role: string;
    department: string;
    geography: string;
    legalEntity: string;
    managerName: string;
    recruiterName: string;
    joiningDateOffsetDays: number;
    primarySkill: string | null;
    skillCriticality: string | null;
    notes: string | null;
  };
};

/** Default demo recipient — real messages go to this inbox / phone. */
export const DEMO_EMAIL = "Helkiah@gmail.com";

export const SCENARIOS: ScenarioDef[] = [
  {
    key: "standard-fte",
    title: "Standard external FTE",
    description:
      "External employee accepts an offer with a standard notice period for an office-based engineering role in India.",
    specRef: "Worked Example 1",
    expectedBehaviour:
      "Intake classifies as standard external onboarding (notify-only); all workstreams run in parallel; new hire ends Day-1 ready with pending items visible.",
    intake: {
      workerName: "Ananya Sharma",
      workerEmail: DEMO_EMAIL,
      workerPhone: null,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Software Engineer",
      department: "Engineering",
      geography: "India",
      legalEntity: "HRO India Pvt Ltd",
      managerName: "Vikram Rao",
      recruiterName: "Priya Nair",
      joiningDateOffsetDays: 30,
      primarySkill: "Java / Spring",
      skillCriticality: "standard",
      notes: null,
    },
  },
  {
    key: "contractor-client",
    title: "Contractor for client project",
    description:
      "Contractor joins for a client-facing project with limited-term access and no employee benefits.",
    specRef: "Worked Example 2",
    expectedBehaviour:
      "Intake routes to the non-employee pathway; plan excludes employee-only benefits; access is limited-duration; client-readiness step requires approval before act.",
    intake: {
      workerName: "Daniel Kovac",
      workerEmail: DEMO_EMAIL,
      workerPhone: null,
      hireType: "contractor",
      workerCategory: "contractor",
      role: "Data Migration Consultant",
      department: "Client Delivery",
      geography: "USA",
      legalEntity: "HRO Americas Inc",
      managerName: "Sarah Whitfield",
      recruiterName: "Vendor Management",
      joiningDateOffsetDays: 14,
      primarySkill: "ETL / Informatica",
      skillCriticality: "standard",
      notes: "Client-facing engagement, 9-month term.",
    },
  },
  {
    key: "rehire",
    title: "Rehire / boomerang",
    description: "A former employee accepts a new role two years after leaving.",
    specRef: "Worked Example 3",
    expectedBehaviour:
      "Intake flags the rehire (approve-before-act) — a human must confirm prior-record continuity before the plan is generated; identity is reactivated, not duplicated; policies are re-acknowledged.",
    intake: {
      workerName: "Meera Krishnan",
      workerEmail: DEMO_EMAIL,
      workerPhone: null,
      hireType: "rehire",
      workerCategory: "employee",
      role: "Senior Business Analyst",
      department: "Consulting",
      geography: "India",
      legalEntity: "HRO India Pvt Ltd",
      managerName: "Arjun Mehta",
      recruiterName: "Priya Nair",
      joiningDateOffsetDays: 21,
      primarySkill: "Business Analysis",
      skillCriticality: "standard",
      notes: "Previously employed 2019-2024, left in good standing.",
    },
  },
  {
    key: "internal-transfer",
    title: "Internal transfer / role change",
    description: "An employee moves into a new role in another business unit.",
    specRef: "Worked Example 4",
    expectedBehaviour:
      "Intake uses the internal-movement path (approve-before-act to preserve identity continuity); access is re-scoped rather than re-provisioned; a role-transition learning path is assigned.",
    intake: {
      workerName: "Tom Okafor",
      workerEmail: DEMO_EMAIL,
      workerPhone: null,
      hireType: "internal-transfer",
      workerCategory: "employee",
      role: "Engineering Manager",
      department: "Platform Engineering",
      geography: "UK",
      legalEntity: "HRO UK Ltd",
      managerName: "Rachel Adams",
      recruiterName: "Internal Mobility",
      joiningDateOffsetDays: 10,
      primarySkill: "Engineering Leadership",
      skillCriticality: "standard",
      notes: "Moving from QA Lead to Engineering Manager; becomes a people manager.",
    },
  },
  {
    key: "bgv-exception",
    title: "BGV exception before joining",
    description: "Background verification returns an exception before the joining date.",
    specRef: "Worked Example 5",
    expectedBehaviour:
      "Documentation & Compliance hard-blocks readiness; the orchestrator routes to TA, Legal and Compliance; no automated adverse decision — humans determine the next step.",
    intake: {
      workerName: "Ravi Patel",
      workerEmail: DEMO_EMAIL,
      workerPhone: null,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Financial Analyst",
      department: "Finance",
      geography: "India",
      legalEntity: "HRO India Pvt Ltd",
      managerName: "Kavita Iyer",
      recruiterName: "Priya Nair",
      joiningDateOffsetDays: 12,
      primarySkill: "Financial Modelling",
      skillCriticality: "standard",
      notes: "BGV exception: employment-history discrepancy flagged by verification vendor.",
    },
  },
  {
    key: "critical-skill",
    title: "Critical skill inflow",
    description:
      "A hire with a scarce cloud capability joining an urgent client project — one of three across two projects.",
    specRef: "Worked Example 6",
    expectedBehaviour:
      "Individual onboarding proceeds normally while the Data & Analytics Agent flags the critical skill inflow, checks readiness bottlenecks and routes an aggregated (privacy-safe) insight to workforce planning.",
    intake: {
      workerName: "Lena Fischer",
      workerEmail: DEMO_EMAIL,
      workerPhone: null,
      hireType: "external-fte",
      workerCategory: "employee",
      role: "Cloud Solutions Architect",
      department: "Cloud Practice",
      geography: "Germany",
      legalEntity: "HRO Europe GmbH",
      managerName: "Stefan Bauer",
      recruiterName: "Talent Acquisition EU",
      joiningDateOffsetDays: 5,
      primarySkill: "Multi-cloud Architecture (AWS/Azure)",
      skillCriticality: "scarce",
      notes: "Urgent: client project kickoff the week after joining. Second project also needs this skill.",
    },
  },
];

export function getScenario(key: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.key === key);
}
