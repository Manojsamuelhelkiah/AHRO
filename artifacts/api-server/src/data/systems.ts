import type { SystemInfo } from "./types";

export const systems: SystemInfo[] = [
  { key: "sf-ec", name: "SAP SuccessFactors Employee Central", category: "hcm", description: "Core HCM system of record for employee master data, org structure and job information." },
  { key: "sf-ecp", name: "SAP SuccessFactors Employee Central Payroll", category: "payroll", description: "Payroll engine holding wage types, retro calculations and payslip output." },
  { key: "workday", name: "Workday HCM", category: "hcm", description: "Alternative core HCM used by clients not on the SAP stack." },
  { key: "benefits-platform", name: "Benefits Administration Platform", category: "benefits", description: "Benefits enrollment, life-event processing and carrier feeds (e.g. Benefitfocus, Darwin)." },
  { key: "time-system", name: "Time & Attendance System", category: "other", description: "Clocking, schedules, absence quotas and time valuation (e.g. Kronos/UKG, SAP Time)." },
  { key: "ticketing", name: "Case Management / Ticketing", category: "ticketing", description: "HR service delivery case system holding tickets, SLA clocks and audit trail." },
  { key: "knowledge-base", name: "Policy Knowledge Base", category: "knowledge", description: "Curated client policy documents, work-council agreements and country regulation notes." },
  { key: "idp", name: "Identity Provider / IAM", category: "identity", description: "Entra ID / IAM used for authentication, role checks and access provisioning." },
  { key: "lms", name: "Learning Management System", category: "other", description: "Course catalog, enrollments, certifications and compliance training records." },
  { key: "ats", name: "Applicant Tracking System", category: "other", description: "Requisitions, candidate pipeline and offer management." },
  { key: "doc-store", name: "Document Management", category: "other", description: "Employee file, contracts, letters and generated documents with retention rules." },
  { key: "vendor-payroll", name: "Local Payroll Vendors", category: "payroll", description: "In-country payroll providers integrated for multi-country clients." },
];
