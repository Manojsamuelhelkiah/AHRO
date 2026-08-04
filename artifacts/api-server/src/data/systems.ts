import type { McpIntegration, SystemInfo } from "./types";

// How each landscape system is exposed to agents through the MCP server.
// Every agent action goes through an MCP tool; these describe the connector
// pattern behind that tool.
const restOData = (note: string): McpIntegration => ({
  method: "rest-odata",
  label: "MCP tool → REST/OData connector",
  note,
});
const ragIndex = (note: string): McpIntegration => ({
  method: "rag-index",
  label: "MCP tool → RAG retrieval index",
  note,
});
const docPipeline = (note: string): McpIntegration => ({
  method: "doc-pipeline",
  label: "MCP tool → document pipeline",
  note,
});
const eventWebhook = (note: string): McpIntegration => ({
  method: "event-webhook",
  label: "MCP tool → API + event webhook",
  note,
});
const scimOidc = (note: string): McpIntegration => ({
  method: "scim-oidc",
  label: "MCP tool → OIDC/SCIM",
  note,
});
const semanticLayer = (note: string): McpIntegration => ({
  method: "semantic-layer",
  label: "MCP tool → semantic data layer (LDM)",
  note,
});
const sftpFile = (note: string): McpIntegration => ({
  method: "sftp-file",
  label: "MCP tool → file/SFTP bridge",
  note,
});

export const systems: SystemInfo[] = [
  { key: "sf-ec", name: "SAP SuccessFactors Employee Central", category: "hcm", description: "Core HCM system of record for employee master data, org structure and job information.", integration: restOData("GET/PUT via SuccessFactors OData v2 APIs wrapped as typed MCP tools (read employee, update master data), OAuth SAML bearer assertion per client tenant.") },
  { key: "sf-ecp", name: "SAP SuccessFactors Employee Central Payroll", category: "payroll", description: "Payroll engine holding wage types, retro calculations and payslip output.", integration: restOData("Payslip and wage-type reads via ECP OData/BAPI facade; writes limited to whitelisted infotype operations behind approval-gated MCP tools.") },
  { key: "workday", name: "Workday HCM", category: "hcm", description: "Alternative core HCM used by clients not on the SAP stack.", integration: restOData("Workday REST/RaaS reports and Web Services exposed as the same canonical MCP tool schema as SF-EC, so flows are landscape-agnostic.") },
  { key: "benefits-platform", name: "Benefits Administration Platform", category: "benefits", description: "Benefits enrollment, life-event processing and carrier feeds (e.g. Benefitfocus, Darwin).", integration: eventWebhook("Enrollment PUTs via vendor REST API where available; life-event status changes stream back through webhooks that update the case.") },
  { key: "time-system", name: "Time & Attendance System", category: "other", description: "Clocking, schedules, absence quotas and time valuation (e.g. Kronos/UKG, SAP Time).", integration: restOData("Quota and schedule GETs via vendor API; absence PUTs validated against time valuation rules before commit.") },
  { key: "ticketing", name: "Case Management / Ticketing", category: "ticketing", description: "HR service delivery case system holding tickets, SLA clocks and audit trail.", integration: eventWebhook("Case create/update PUTs via REST; SLA and status events stream back via webhooks so agents react to state changes without polling.") },
  { key: "knowledge-base", name: "Policy Knowledge Base", category: "knowledge", description: "Curated client policy documents, work-council agreements and country regulation notes.", integration: ragIndex("Policy references are retrieved from a per-client vector + keyword index (chunked documents with country/entity metadata filters); agents cite retrieved passages, never free-recall.") },
  { key: "idp", name: "Identity Provider / IAM", category: "identity", description: "Entra ID / IAM used for authentication, role checks and access provisioning.", integration: scimOidc("Identity checks via OIDC token introspection; role/entitlement GETs and provisioning PUTs via SCIM 2.0 endpoints.") },
  { key: "lms", name: "Learning Management System", category: "other", description: "Course catalog, enrollments, certifications and compliance training records.", integration: restOData("Catalog and enrollment operations via vendor REST API (xAPI/LTI where offered), wrapped as MCP tools.") },
  { key: "ats", name: "Applicant Tracking System", category: "other", description: "Requisitions, candidate pipeline and offer management.", integration: restOData("Requisition and candidate GET/PUT via vendor REST API with field-level scoping per client.") },
  { key: "doc-store", name: "Document Management", category: "other", description: "Employee file, contracts, letters and generated documents with retention rules.", integration: docPipeline("Uploads pass through an extraction pipeline (OCR + small-model field extraction) before filing; generated letters are written back with retention metadata.") },
  { key: "legacy-db", name: "Legacy HR Databases", category: "other", description: "Direct database estates behind or beside the systems of record: historic payroll archives, country-specific side tables, shadow spreadsheets loaded to SQL — typically undocumented, with broken schemas and no data lineage.", integration: semanticLayer("Read-only access through a governed semantic data layer: a schema catalog is inferred and curated, then a structured-data model (LDM/NL2SQL) generates validated queries per request; every query and result set is logged to reconstruct lineage over time. No direct writes — corrections flow through the owning system of record.") },
  { key: "vendor-payroll", name: "Local Payroll Vendors", category: "payroll", description: "In-country payroll providers integrated for multi-country clients.", integration: sftpFile("Many local vendors lack APIs: MCP tools produce validated file drops over SFTP and reconcile acknowledgement files; API-capable vendors use REST connectors.") },
];
