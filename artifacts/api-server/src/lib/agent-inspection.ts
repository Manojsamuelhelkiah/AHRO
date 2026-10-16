import { createHash } from "node:crypto";
import {
  ONBOARDING_MODEL, TEXT_TOKEN_BUFFER, DEFAULT_TEXT_MAX_TOKENS, WELCOME_MAX_TOKENS, PLAN_SYSTEM, planTemplate, WELCOME_SYSTEM, welcomeTemplate,
  EXPLANATION_SYSTEM, EXPLANATION_CATEGORIES, explanationTemplate, VERIFICATION_SYSTEM,
  verificationParagraphTemplate, EXPLANATION_MODEL_SETTINGS, EXPLANATION_TIMEOUT_MS,
} from "./onboarding/inspectable-prompts";

const association = "Independent onboarding workflow component; browsing association only. It does not resolve this catalogue binding and is not the registered role's executor.";
function workflow(name: string, source: string, system: string, template: string, settings: string) {
  return {
    name, association, source, system, template, provider: "OpenAI", model: ONBOARDING_MODEL, settings,
    hash: createHash("sha256").update(JSON.stringify({ system, template, settings, model: ONBOARDING_MODEL })).digest("hex"),
    status: "Implemented workflow path; dispatch requires its existing case, disclosure and provider-governance gates. Not invoked by inspection.",
  };
}
const textSettings = (budget: number) => JSON.stringify({
  model: ONBOARDING_MODEL, max_completion_tokens: budget + TEXT_TOKEN_BUFFER,
  response_format: "text", temperature: "not explicitly configured", reasoning_effort: "not explicitly configured",
});
const explanationSettings = JSON.stringify({
  ...EXPLANATION_MODEL_SETTINGS, response_format: "strict json_schema (stage-specific, allowed source IDs bound at runtime)",
  timeout_ms: EXPLANATION_TIMEOUT_MS, maxRetries: 0, temperature: "not explicitly configured",
});
export function onboardingInspectionWorkflows() {
  return [
    workflow("Onboarding plan narrative", "onboarding/engine.ts · inspectable-prompts.ts · llm.ts",
      PLAN_SYSTEM, planTemplate("{{authorized_plan_evidence}}"), textSettings(DEFAULT_TEXT_MAX_TOKENS)),
    workflow("Pre-boarding welcome draft", "onboarding/engine.ts · inspectable-prompts.ts · llm.ts",
      WELCOME_SYSTEM, welcomeTemplate({ role: "{{role}}", department: "{{department}}", joiningDate: "{{joiningDate}}", geography: "{{geography}}" }), textSettings(WELCOME_MAX_TOKENS)),
    ...Object.entries(EXPLANATION_CATEGORIES).map(([category, instruction]) =>
      workflow(`Case explanation · ${category}`, "onboarding/case-explainability.ts · case-explainability-completion.ts · inspectable-prompts.ts",
        EXPLANATION_SYSTEM, explanationTemplate(instruction, "{{case_id}}", "{{server_curated_evidence}}"), explanationSettings)),
    workflow("Case explanation grounding verification", "onboarding/case-explainability.ts · case-explainability-completion.ts · inspectable-prompts.ts",
      VERIFICATION_SYSTEM, verificationParagraphTemplate("{{paragraph_index}}", "{{candidate_claim}}", ["{{referenced_source_excerpts}}"]), explanationSettings),
  ];
}

export const INTAKE_CONVERSION_CONTRACT = [
  "Rule-driven operating contract — intake-conversion/v1; no model or system prompt.",
  "Only newly received supported email templates captured under the same active registration generation are eligible. Historical backlog remains manual.",
  "Resolve the current tenant binding, exact active principal/version, eligible named owner's membership revision and current intake read/edit/confidential-field permissions on every conversion. Temporary platform elevation is not standing authority.",
  "Require the currently connected mailbox, complete explicit unambiguous template, valid lifecycle and no unresolved duplicate or source problem.",
  "A bounded worker claims at most 25 pending requests. Tenant transaction fencing makes case creation, linkage and audit atomic. Retry transient failures; generation/authority changes pause work without revival by re-registration.",
  "Output is a held case with quarantined attachments. Do not fabricate human review, approve evidence, contact anyone, release workstreams or close a case.",
].join("\n\n");

/** Evidence-backed presentation only. No lookup, model call, mutation or registration. */
export function agentInspection(key: string) {
  const intake = key === "intake-conversion";
  const onboarding = key === "onboarding";
  return {
    execution: intake ? "Rule-driven intake conversion capability; eligibility is live-checked on each conversion."
      : "No executing model or prompt is attached to this catalogue role. Registration records a principal binding, not deployment.",
    instructions: intake ? INTAKE_CONVERSION_CONTRACT
      : "Coordination definition only. No role-specific runtime system instructions exist. The responsibility, prerequisites and canonical intent mappings describe reviewed coordination scope, not execution authority.",
    workflows: onboarding ? onboardingInspectionWorkflows() : [],
    tools: [
      {
        name: "tool.case.read", input: "agentId; UUID runId and correlationId; positive caseId; purpose (1–300 characters); optional organizationId checked against trusted tenant",
        output: "success: auditId and { caseId, lifecycleStage }; denied: reasonCode/auditId; failure: auditId",
        access: "POST /api/agent-invocations; active tenant principal, authenticated accountable owner initiation, same-tenant case, effective tool.case.read + data.case.readiness.read",
        association: "Implemented shared principal tool, not a role executor or an LLM function-call binding. Inspection never calls it.",
      },
      {
        name: "tool.context.read", input: "Same invocation envelope as tool.case.read",
        output: "success: auditId, caseId, lifecycleStage and authorized TransactionWorkingContext projection; denied/failure recorded",
        access: "Active tenant principal and accountable owner initiation; same-tenant case; effective tool.context.read + flow.case.read and projection-level disclosure checks",
        association: "Implemented shared principal tool, not a role executor or an LLM function-call binding.",
      },
      ...(intake ? [{
        name: "intake-conversion/v1", input: "Server-queued new email request ID, tenant and captured registration generation; current mailbox and request version",
        output: "Atomically linked held case, or manual/paused/retry queue disposition",
        access: "Server worker only; live resolveIntakeConversion / requireIntakeConversion authorization. Not a generally invocable tool.",
        association: "Implemented deterministic capability of this registration; intake-conversion-worker.ts and hro-email-service.ts",
      }] : []),
    ],
    contextSources: [
      "Canonical intent taxonomy: reviewed service-level coordination mappings, never proof of execution.",
      "Shared principal tools: authorized tenant/case metadata and transaction working context; no public knowledge index configured.",
      ...(onboarding ? ["Independent plan workflow: authorized plan evidence and approved-checkpoint rule adjustments.",
        "Independent explanation workflow: server-curated, redacted case evidence with recorded source references; no arbitrary conversation history sent.",
        "Independent welcome workflow: role, department, start date and geography under existing provider governance."] : []),
      ...(intake ? ["New explicit supported email templates, source/duplicate checks, registration generation, current owner access and connected mailbox. Attachments remain quarantined."] : []),
    ],
    protocols: [
      { name: "Application calls", status: "Implemented", description: "In-process TypeScript calls and authenticated application HTTP routes; not A2A." },
      { name: "Provider HTTPS", status: onboarding ? "Implemented in independent workflows" : "Not configured for this role",
        description: "OpenAI-compatible completion API is used by linked onboarding workflow paths only. No Microsoft hosting or deployment is implied." },
      { name: "Mailbox / webhooks", status: intake ? "Implemented intake integration" : "Independent application integrations",
        description: intake ? "Connected Gmail ingestion feeds the deterministic server conversion queue. Not agent-to-agent messaging."
          : "Application email and WhatsApp/webhook paths have independent authorization. No adapter is bound to this role." },
      { name: "A2A", status: "Not implemented", description: "Agent-to-agent interoperability. No verified A2A adapter, endpoint or messaging implementation." },
      { name: "MCP", status: "Not implemented", description: "Model-to-tool/context interoperability. Application tools are not an MCP server or connected MCP adapter." },
    ],
    collaborations: [
      "Proposed design metadata: domain and supporting roles coordinate policy, evidence and human handoffs through their reviewed responsibilities. This is not messaging, authorization or evidence of A2A.",
      ...(key === "systems-watcher" ? ["Existing connector watchers are independently implemented components, not this registered principal."] : []),
      ...(key === "documents-records" ? ["The employment-records reasoning component is independent; its legacy case-free LLM calls are denied by llm.ts. No catalogue executor association is inferred."] : []),
      ...(intake ? ["Implemented local handoff: intake conversion creates a held case for the applicable lifecycle. It does not dispatch a downstream agent."] : []),
    ],
    unavailable: ["Role deployment/resource ID", "Role endpoint", "Knowledge deployment", "Evaluation scores", "Latency", "Token spend", "Inference telemetry"],
  };
}
