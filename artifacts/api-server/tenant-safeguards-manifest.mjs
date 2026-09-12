export const tenantSafeguards = [
  { table: "organization_memberships", phaseB: false },
  { table: "scenarios", phaseB: true },
  { table: "scenario_files", phaseB: false },
  { table: "scenario_upload_intents", phaseB: false },
  { table: "custom_intents", phaseB: true },
  { table: "actuals_overlays", phaseB: true },
  { table: "flow_overrides", phaseB: true },
  { table: "onb_cases", phaseB: true },
  { table: "onb_events", phaseB: true },
  { table: "onb_approvals", phaseB: true },
  { table: "onb_communications", phaseB: true },
  { table: "onb_system_checks", phaseB: true },
  { table: "onb_settings", phaseB: true },
  // Added after the historical Phase A/B migration pair; born fail-closed.
  { table: "onb_checklist_templates", phaseB: false },
  { table: "onb_checklist_profiles", phaseB: false },
  { table: "onb_connectors", phaseB: true },
  { table: "onb_effect_journal", phaseB: true },
  { table: "onb_documents", phaseB: true },
  { table: "onb_call_slots", phaseB: true },
  { table: "onb_voice_sessions", phaseB: true },
  { table: "onb_watch_emails", phaseB: true },
  { table: "onb_employee_records", phaseB: true },
  { table: "onb_guardrail_events", phaseB: true },
  { table: "onb_case_logistics", phaseB: false },
  { table: "onb_candidate_links", phaseB: false },
  { table: "onb_candidate_sessions", phaseB: false },
  { table: "onb_candidate_uploads", phaseB: false },
  { table: "custom_intent_routing_labels", phaseB: true },
  { table: "pricing_rate_sets", phaseB: true },
  { table: "pricing_sheets", phaseB: true },
  { table: "ea_assessments", phaseB: true },
  // Added after the historical Phase A/B migration pair; born fail-closed.
  { table: "onb_readiness_sla_policies", phaseB: false },
  { table: "onb_readiness_sla_snapshots", phaseB: false },
  { table: "onb_readiness_sla_case_state", phaseB: false },
  { table: "onb_readiness_sla_attestations", phaseB: false },
  { table: "onb_readiness_sla_ledger", phaseB: false },
  { table: "onb_readiness_sla_outbox", phaseB: false },
  // Historical decisions deliberately outlive the live case/approval/org
  // relationships; append-only DB triggers protect the retained snapshot.
  { table: "onb_approval_history", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "onb_approval_notifications", phaseB: false },
  { table: "onb_action_center_actions", phaseB: false },
  // 0043 table is tenant-owned from creation; include it in startup FK/RLS
  // verification rather than treating its organization column as unowned.
  { table: "demo_controller_setup_requests", phaseB: false },
  { table: "onb_policy_evidence", phaseB: false },
  { table: "onb_policy_authorities", phaseB: false },
  { table: "onb_job_profiles", phaseB: false },
  { table: "onb_policy_recommendations", phaseB: false },
  { table: "onb_intake_batches", phaseB: false },
  { table: "onb_intake_batch_people", phaseB: false },
  // Protected evidence has no business-record FK so deletion cannot cascade
  // accountability history. Tenant isolation is enforced in every query.
  { table: "onb_audit_entries", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "onb_audit_heads", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "onb_audit_lifecycles", phaseB: false, requiresOrganizationForeignKey: false },
  // Governance authority records are born tenant-scoped and fail closed.
  { table: "onb_authority_governance", phaseB: false },
  { table: "onb_authority_assignments", phaseB: false },
  { table: "onb_authority_audit", phaseB: false },
];

export const tenantTables = tenantSafeguards.map(({ table }) => table);

// Having an organization_id is an isolation requirement for every tenant
// table. Parent-row existence is a different requirement: retained,
// append-only evidence intentionally survives deletion of its live tenant.
export const organizationParentValidatedTenantTables = tenantSafeguards
  .filter(({ requiresOrganizationForeignKey = true }) => requiresOrganizationForeignKey)
  .map(({ table }) => table);

export const phaseBTenantTables = tenantSafeguards
  .filter(({ phaseB }) => phaseB)
  .map(({ table }) => table);

export const expectedForeignKeys = [
  ...tenantSafeguards
    .filter(
      ({ requiresOrganizationForeignKey = true }) =>
        requiresOrganizationForeignKey,
    )
    .map(({ table }) => ({
      table,
      columns: ["organization_id"],
      referencedTable: "organizations",
      referencedColumns: ["id"],
    })),
  {
    table: "onb_watch_emails",
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  },
  {
    table: "onb_watch_emails",
    columns: ["organization_id", "check_id"],
    referencedTable: "onb_system_checks",
    referencedColumns: ["organization_id", "id"],
  },
  ...[
    "onb_readiness_sla_snapshots",
    "onb_readiness_sla_case_state",
    "onb_readiness_sla_attestations",
    "onb_readiness_sla_ledger",
    "onb_readiness_sla_outbox",
    "onb_approval_notifications",
  ].map((table) => ({
    table,
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  })),
  ...["onb_approval_notifications"].map((table) => ({
    table,
    columns: ["organization_id", "approval_id"],
    referencedTable: "onb_approvals",
    referencedColumns: ["organization_id", "id"],
  })),
  {
    table: "onb_action_center_actions",
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  },
  {
    table: "onb_policy_evidence",
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  },
  {
    table: "onb_policy_authorities",
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  },
  {
    table: "onb_intake_batch_people",
    columns: ["organization_id", "batch_id"],
    referencedTable: "onb_intake_batches",
    referencedColumns: ["organization_id", "batch_id"],
  },
  {
    table: "onb_intake_batch_people",
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  },
  {
    table: "onb_authority_assignments",
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  },
];