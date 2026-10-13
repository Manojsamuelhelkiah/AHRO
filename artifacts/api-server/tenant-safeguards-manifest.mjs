export const tenantSafeguards = [
  { table: "human_permission_decisions", phaseB: false },
  { table: "employee_vault_products", phaseB: false },
  { table: "employee_vault_requests", phaseB: false },
  { table: "employee_vault_receipts", phaseB: false },
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
  // Sensitive upload reservations deliberately retain interrupted-upload
  // accountability independently of case/document cleanup.
  { table: "onb_candidate_upload_reservations", phaseB: false },
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
  // Curated HR policy sources and handoffs are tenant-owned from creation.
  // Their distinct tables are deliberately checked independently of the
  // owner-managed checklist policy tables.
  { table: "onb_hr_policy_sources", phaseB: false },
  { table: "onb_hr_policy_imports", phaseB: false },
  { table: "onb_hr_policy_versions", phaseB: false },
  { table: "onb_hr_policy_handoffs", phaseB: false },
  { table: "onb_hr_policy_excerpts", phaseB: false },
  { table: "onb_hr_policy_reminders", phaseB: false },
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
  { table: "onb_governance_decisions", phaseB: false },
  { table: "onb_governance_decision_reviews", phaseB: false },
  { table: "onb_governance_authority_assignments", phaseB: false },
  { table: "onb_governance_requirements", phaseB: false },
  { table: "onb_governance_history", phaseB: false },
  { table: "onb_governance_reminders", phaseB: false },
  { table: "onb_governance_dispatch_markers", phaseB: false },
  { table: "onb_audit_anchor_outbox", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "onb_audit_anchor_receipts", phaseB: false, requiresOrganizationForeignKey: false },
  // Sensitive-data lifecycle records are tenant-owned from creation.
  { table: "onb_sensitive_lifecycle_policies", phaseB: false },
  // Holds, manifests, and deletion jobs intentionally do not cascade from a
  // case: cleanup must never erase retention/deletion accountability.
  { table: "onb_sensitive_lifecycle_holds", phaseB: false },
  { table: "onb_sensitive_object_manifests", phaseB: false },
  { table: "onb_sensitive_object_derivatives", phaseB: false },
  { table: "onb_sensitive_lifecycle_confirmations", phaseB: false },
  { table: "onb_sensitive_lifecycle_deletion_jobs", phaseB: false },
  // A disposable cursor is recreated by workers; it intentionally has no
  // organization parent FK so tenant cleanup cannot be blocked by a cursor.
  { table: "onb_sensitive_lifecycle_scan_cursors", phaseB: false, requiresOrganizationForeignKey: false },
  // Standard intake and provider contracts are tenant-owned at creation and
  // must be covered by startup tenant/FK/RLS verification.
  { table: "onb_standard_intake_events", phaseB: false },
  { table: "onb_standard_provider_configs", phaseB: false },
  { table: "onb_standard_provider_source_records", phaseB: false },
  { table: "onb_standard_provider_decisions", phaseB: false },
  // Early-tenure and outcome evidence are created after the historic Phase
  // A/B pair. They are tenant-owned from birth and must fail closed at startup.
  { table: "onb_early_tenure_policy_versions", phaseB: false },
  { table: "onb_early_tenure_case_snapshots", phaseB: false },
  { table: "onb_early_tenure_assignments", phaseB: false },
  { table: "onb_early_tenure_evidence", phaseB: false },
  { table: "onb_early_tenure_checkins", phaseB: false },
  { table: "onb_early_tenure_reminders", phaseB: false },
  { table: "onb_probation_decisions", phaseB: false },
  { table: "onb_early_tenure_survey_responses", phaseB: false },
  { table: "onb_employment_outcome_evidence", phaseB: false },
  { table: "onb_outcome_evidence_authority_receipts", phaseB: false },
  // Workforce-transfer records include opaque source-worker payloads and
  // custody/reconciliation evidence. Every representation is tenant-owned
  // from creation and is verified independently at startup.
  { table: "onb_transfer_programs", phaseB: false },
  { table: "onb_transfer_pathways", phaseB: false },
  { table: "onb_transfer_data_governance", phaseB: false },
  { table: "onb_transfer_populations", phaseB: false },
  { table: "onb_transfer_import_previews", phaseB: false },
  { table: "onb_transfer_imports", phaseB: false },
  { table: "onb_transfer_workers", phaseB: false },
  { table: "onb_transfer_consultation_milestones", phaseB: false },
  { table: "onb_transfer_objections", phaseB: false },
  { table: "onb_transfer_integration_actions", phaseB: false },
  { table: "onb_transfer_operational_supersessions", phaseB: false },
  { table: "onb_transfer_cutover_plans", phaseB: false },
  { table: "onb_transfer_cutover_reconciliations", phaseB: false },
  { table: "onb_transfer_cutover_signoffs", phaseB: false },
  { table: "onb_transfer_reconciliation_repairs", phaseB: false },
  { table: "onb_transfer_kpi_evidence", phaseB: false },
  { table: "onb_transfer_kpi_definitions", phaseB: false },
  // Frontline operations are tenant-owned from creation and remain subject to
  // the same tenant/FK/RLS startup safeguards as the other case records.
  { table: "onb_frontline_evidence", phaseB: false },
  { table: "onb_frontline_fulfillments", phaseB: false },
  { table: "onb_frontline_policy_exceptions", phaseB: false },
  { table: "onb_frontline_release_state", phaseB: false },
  { table: "onb_frontline_kpi_inputs", phaseB: false },
  // Access governance records are tenant-scoped; join tables inherit tenant
  // ownership through their composite parent FKs rather than direct org FKs.
  { table: "access_agents", phaseB: false },
  { table: "agent_catalogue_bindings", phaseB: false },
  { table: "agent_catalogue_setup_receipts", phaseB: false },
  { table: "access_user_groups", phaseB: false },
  { table: "access_user_group_members", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "access_security_groups", phaseB: false },
  { table: "access_security_group_policies", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "access_security_group_user_groups", phaseB: false, requiresOrganizationForeignKey: false },
  { table: "access_security_group_attachments", phaseB: false },
  { table: "access_principal_security_group_attachments", phaseB: false },
  { table: "access_named_grants", phaseB: false },
  { table: "access_governance_history", phaseB: false },
  // Invocation audit retains tenant identity but intentionally has no
  // organization FK, so cleanup cannot remove append-only invocation evidence.
  { table: "agent_invocation_audit", phaseB: false, requiresOrganizationForeignKey: false },
];

export const tenantTables = tenantSafeguards.map(({ table }) => table);

// Explicit independent domain inventory: these are not unscoped HRO tenant data.
export const employeeOwnedTables = [
  "employee_vault_profiles", "employee_vault_documents",
  "employee_vault_checks", "employee_vault_audit",
];
export const platformVaultConfigurationTables = ["employee_vault_policies", "employee_vault_issuers"];

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
  { table: "agent_catalogue_bindings", columns: ["organization_id", "agent_id"], referencedTable: "access_agents", referencedColumns: ["organization_id", "id"] },
  ...["employee_vault_documents", "employee_vault_checks", "employee_vault_audit", "employee_vault_requests"].map(table => ({
    table, columns: ["profile_id"], referencedTable: "employee_vault_profiles", referencedColumns: ["id"],
  })),
  ...["employee_vault_requests", "employee_vault_receipts"].map(table => ({
    table, columns: ["organization_id", "case_id"], referencedTable: "onb_cases", referencedColumns: ["organization_id", "id"],
  })),
  { table: "employee_vault_receipts", columns: ["organization_id", "request_id"], referencedTable: "employee_vault_requests", referencedColumns: ["organization_id", "id"] },
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
  ...[
    "onb_standard_intake_events",
    "onb_standard_provider_source_records",
  ].map((table) => ({
    table,
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
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
    table: "onb_hr_policy_versions",
    columns: ["organization_id", "policy_id"],
    referencedTable: "onb_hr_policy_sources",
    referencedColumns: ["organization_id", "policy_id"],
  },
  {
    table: "onb_hr_policy_excerpts",
    columns: ["organization_id", "policy_id", "version"],
    referencedTable: "onb_hr_policy_versions",
    referencedColumns: ["organization_id", "policy_id", "version"],
  },
  {
    table: "onb_hr_policy_reminders",
    columns: ["organization_id", "policy_id", "version"],
    referencedTable: "onb_hr_policy_versions",
    referencedColumns: ["organization_id", "policy_id", "version"],
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
  {
    table: "onb_sensitive_object_derivatives",
    columns: ["manifest_id"],
    referencedTable: "onb_sensitive_object_manifests",
    referencedColumns: ["id"],
  },
  ...[
    "onb_early_tenure_case_snapshots",
    "onb_early_tenure_assignments",
    "onb_early_tenure_checkins",
    "onb_early_tenure_reminders",
    "onb_probation_decisions",
    "onb_early_tenure_survey_responses",
    "onb_employment_outcome_evidence",
    "onb_outcome_evidence_authority_receipts",
  ].map((table) => ({
    table,
    columns: ["organization_id", "case_id"],
    referencedTable: "onb_cases",
    referencedColumns: ["organization_id", "id"],
  })),
  {
    table: "onb_early_tenure_evidence",
    columns: ["organization_id", "assignment_id"],
    referencedTable: "onb_early_tenure_assignments",
    referencedColumns: ["organization_id", "id"],
  },
  ...[
    "onb_transfer_pathways",
    "onb_transfer_data_governance",
    "onb_transfer_populations",
    "onb_transfer_consultation_milestones",
    "onb_transfer_integration_actions",
    "onb_transfer_operational_supersessions",
    "onb_transfer_cutover_plans",
    "onb_transfer_kpi_evidence",
    "onb_transfer_kpi_definitions",
  ].map((table) => ({
    table,
    columns: ["organization_id", "program_id"],
    referencedTable: "onb_transfer_programs",
    referencedColumns: ["organization_id", "id"],
  })),
  ...[
    "onb_transfer_import_previews",
    "onb_transfer_imports",
    "onb_transfer_workers",
  ].map((table) => ({
    table,
    columns: ["organization_id", "population_id"],
    referencedTable: "onb_transfer_populations",
    referencedColumns: ["organization_id", "id"],
  })),
  {
    table: "onb_transfer_imports",
    columns: ["organization_id", "preview_id"],
    referencedTable: "onb_transfer_import_previews",
    referencedColumns: ["organization_id", "id"],
  },
  {
    table: "onb_transfer_workers",
    columns: ["organization_id", "import_id"],
    referencedTable: "onb_transfer_imports",
    referencedColumns: ["organization_id", "id"],
  },
  ...[
    "onb_transfer_objections",
    "onb_transfer_cutover_reconciliations",
    "onb_transfer_reconciliation_repairs",
    "onb_transfer_kpi_evidence",
  ].map((table) => ({
    table,
    columns: ["organization_id", "worker_id"],
    referencedTable: "onb_transfer_workers",
    referencedColumns: ["organization_id", "id"],
  })),
  ...[
    "onb_transfer_cutover_reconciliations",
    "onb_transfer_cutover_signoffs",
    "onb_transfer_reconciliation_repairs",
  ].map((table) => ({
    table,
    columns: ["organization_id", "plan_id"],
    referencedTable: "onb_transfer_cutover_plans",
    referencedColumns: ["organization_id", "id"],
  })),
];