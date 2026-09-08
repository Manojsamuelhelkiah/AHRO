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
  {
    key: "payroll-bank-change",
    title: "Payroll bank-detail change",
    description: "An employee requests a bank-account change before the next payroll cutoff.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Payroll validates identity and effective date, binds fraud-control and payroll approvals to the exact account-change proposal, then confirms the payroll source record.",
    intake: {
      workerName: "Aarav Menon", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Product Manager",
      department: "Product", geography: "India", legalEntity: "HRO India Pvt Ltd",
      managerName: "Nisha Kapoor", recruiterName: "HR Service Centre", joiningDateOffsetDays: 8,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic payroll case: bank details change before cutoff; dual approval required.",
    },
  },
  {
    key: "benefits-life-event",
    title: "Benefits life-event enrolment",
    description: "An employee reports a qualifying life event and requests dependent coverage.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Benefits verifies event evidence, policy eligibility and effective date before source-confirmed enrolment.",
    intake: {
      workerName: "Sofia Martinez", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Sales Director",
      department: "Sales", geography: "USA", legalEntity: "HRO Americas Inc",
      managerName: "Michael Chen", recruiterName: "Benefits Operations", joiningDateOffsetDays: 16,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic benefits case: qualifying life event with dependent addition.",
    },
  },
  {
    key: "leave-parental",
    title: "Parental leave request",
    description: "An employee requests parental leave spanning payroll and manager planning.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Leave validates entitlement, policy and dates; required human decisions are captured before HRIS and payroll calendars are updated.",
    intake: {
      workerName: "Oliver Hughes", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "UX Researcher",
      department: "Design", geography: "UK", legalEntity: "HRO UK Ltd",
      managerName: "Amelia Clark", recruiterName: "Leave Operations", joiningDateOffsetDays: 35,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic leave case: parental leave with payroll and capacity dependencies.",
    },
  },
  {
    key: "compliance-work-authorization",
    title: "Work authorization renewal",
    description: "A time-bound work authorization is approaching expiry.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Compliance gathers current evidence, applies country policy, blocks unlawful continuation and records named legal review where required.",
    intake: {
      workerName: "Mina Park", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Data Scientist",
      department: "Data & AI", geography: "Germany", legalEntity: "HRO Europe GmbH",
      managerName: "Jonas Weber", recruiterName: "Global Mobility", joiningDateOffsetDays: 28,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic compliance case: work authorization expiry in 90 days.",
    },
  },
  {
    key: "offboarding-voluntary",
    title: "Voluntary offboarding",
    description: "An employee resignation requires coordinated payroll, access and asset closure.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Offboarding derives the applicable closure plan, sequences access revocation and asset recovery, and confirms final payroll and retained evidence.",
    intake: {
      workerName: "Noah Williams", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "offboarding", workerCategory: "employee", role: "Finance Manager",
      department: "Finance", geography: "USA", legalEntity: "HRO Americas Inc",
      managerName: "Grace Kim", recruiterName: "HR Operations", joiningDateOffsetDays: 20,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic offboarding case: voluntary resignation and coordinated Day-0 closure.",
    },
  },
  {
    key: "helpdesk-employment-letter",
    title: "Employment confirmation letter",
    description: "An employee requests a signed employment letter for a bank.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "The service agent verifies identity, retrieves authoritative employment data, generates the approved template and retains the signed document locator.",
    intake: {
      workerName: "Fatima Al-Hassan", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Procurement Lead",
      department: "Operations", geography: "UAE", legalEntity: "HRO Middle East FZ LLC",
      managerName: "Omar Rahman", recruiterName: "HR Helpdesk", joiningDateOffsetDays: 4,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic helpdesk case: employment confirmation letter for banking.",
    },
  },
  {
    key: "it-privileged-access",
    title: "Privileged application access",
    description: "A finance employee requests elevated access to a sensitive application.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "IAM binds manager, application-owner and security approvals to the exact entitlement set and rejects segregation-of-duties conflicts.",
    intake: {
      workerName: "Lucas Bernard", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Treasury Analyst",
      department: "Finance", geography: "France", legalEntity: "HRO Europe GmbH",
      managerName: "Claire Dubois", recruiterName: "IT Service Management", joiningDateOffsetDays: 6,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic IAM case: privileged treasury application access with SoD controls.",
    },
  },
  {
    key: "learning-mandatory-certification",
    title: "Mandatory certification assignment",
    description: "A regulated-role curriculum must be assigned and completed by a deadline.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Learning resolves the authoritative worker identity, assigns the correct curriculum version and confirms LMS enrolment and completion evidence.",
    intake: {
      workerName: "Keiko Tanaka", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Quality Auditor",
      department: "Quality", geography: "Japan", legalEntity: "HRO APAC KK",
      managerName: "Haruto Sato", recruiterName: "Learning Operations", joiningDateOffsetDays: 18,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic learning case: annual regulated-role certification.",
    },
  },
  {
    key: "mobility-country-transfer",
    title: "Cross-border employee transfer",
    description: "An employee moves to a new country and employing entity.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Mobility coordinates immigration, tax, payroll, entity, benefits and access dependencies without creating a duplicate worker identity.",
    intake: {
      workerName: "Emma Schneider", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "internal-transfer", workerCategory: "employee", role: "Solutions Consultant",
      department: "Consulting", geography: "Singapore", legalEntity: "HRO APAC Pte Ltd",
      managerName: "Wei Lim", recruiterName: "Global Mobility", joiningDateOffsetDays: 45,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic mobility case: Germany-to-Singapore entity transfer.",
    },
  },
  {
    key: "documents-policy-acknowledgement",
    title: "Policy acknowledgement",
    description: "A revised information-security policy requires employee acknowledgement.",
    specRef: "Synthetic lifecycle coverage",
    expectedBehaviour: "Worker records targets the correct population and policy version, records delivery separately from acknowledgement and escalates overdue responses.",
    intake: {
      workerName: "Samuel Ndlovu", workerEmail: DEMO_EMAIL, workerPhone: null,
      hireType: "employee-service", workerCategory: "employee", role: "Support Engineer",
      department: "Customer Support", geography: "South Africa", legalEntity: "HRO Africa Pty Ltd",
      managerName: "Thandi Mokoena", recruiterName: "Policy Operations", joiningDateOffsetDays: 12,
      primarySkill: null, skillCriticality: "standard",
      notes: "Synthetic documents case: revised information-security policy acknowledgement.",
    },
  },
];

export function getScenario(key: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.key === key);
}
