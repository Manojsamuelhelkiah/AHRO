import { openai } from "@workspace/integrations-openai-ai-server";
import { dispatchHroAi } from "../hro-context/manager";
import {
  dispatchWithProviderGovernance,
  PROVIDER_GOVERNANCE_WORKFLOW,
  type ProviderGovernanceCase,
} from "./governance-provider-boundary";

import { ONBOARDING_MODEL, TEXT_TOKEN_BUFFER, DEFAULT_TEXT_MAX_TOKENS } from "./inspectable-prompts";

async function complete(system: string, user: string, maxTokens: number, json = false) {
  return dispatchHroAi({
    model: ONBOARDING_MODEL,
    max_completion_tokens: maxTokens + TEXT_TOKEN_BUFFER,
    ...(json ? { response_format: { type: "json_object" as const } } : {}),
    messages: [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ],
  }, request => openai.chat.completions.create(request));
}

/**
 * Only aggregate, suppression-safe operational analytics may use this path.
 * The branded scope prevents case evidence from being passed as a casual
 * string-based completion request.
 */
export type AggregateOperationalLlmContext = Readonly<{
  scope: "aggregate-onboarding-insights";
  system: string;
  user: string;
  maxTokens?: number;
}>;

export async function llmCompleteAggregate(
  _context: AggregateOperationalLlmContext,
): Promise<string | null> {
  // Aggregate analytics has no case-scoped governance snapshot with which to
  // authorize opaque labels and cohort data. Do not turn a response-only
  // suppression rule into an outbound disclosure path. The analytics route
  // supplies a deterministic local narrative instead.
  return null;
}

/**
 * Single LLM call used by the reasoning ("LLM engine") agents.
 * Returns the text, or null on failure — callers must degrade gracefully
 * and record the failure in the audit trail instead of silently faking output.
 */
export function llmComplete(
  caseRow: ProviderGovernanceCase,
  system: string,
  user: string,
  maxTokens?: number,
): Promise<string | null>;
/** @deprecated Case-free completions are denied to prevent prompt disclosure. */
export function llmComplete(system: string, user: string, maxTokens?: number): Promise<string | null>;
export async function llmComplete(
  caseOrSystem: ProviderGovernanceCase | string,
  systemOrUser: string,
  userOrMax?: string | number,
  configuredMaxTokens = DEFAULT_TEXT_MAX_TOKENS,
): Promise<string | null> {
  try {
    if (typeof caseOrSystem === "string") return null;
    const caseRow = caseOrSystem;
    const system = systemOrUser;
    const user = typeof userOrMax === "string" ? userOrMax : "";
    const maxTokens = configuredMaxTokens;
    const guarded = await dispatchWithProviderGovernance({
      caseRow,
      workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
      operation: `onboarding-llm-text:${caseRow.id}:${maxTokens}`,
      providerId: "openai",
      dataClass: "candidate-contact",
      dispatch: () => complete(system, user, maxTokens),
      disposition: () => "sent",
    });
    if (!guarded.dispatched) return null;
    const resp = guarded.value;
    const text = resp.choices[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch (err) {
    console.error("[onboarding llm] completion failed:", err);
    return null;
  }
}

/**
 * LLM call that must return a JSON object. Returns the parsed object or
 * null on any failure (call error, empty output, unparseable JSON) —
 * callers must treat null as "the AI could not handle this".
 */
export function llmCompleteJson<T>(
  caseRow: ProviderGovernanceCase,
  system: string,
  user: string,
  maxTokens?: number,
): Promise<T | null>;
/** @deprecated Case-free completions are denied to prevent prompt disclosure. */
export function llmCompleteJson<T>(system: string, user: string, maxTokens?: number): Promise<T | null>;
export async function llmCompleteJson<T>(
  caseOrSystem: ProviderGovernanceCase | string,
  systemOrUser: string,
  userOrMax?: string | number,
  configuredMaxTokens = DEFAULT_TEXT_MAX_TOKENS,
): Promise<T | null> {
  try {
    if (typeof caseOrSystem === "string") return null;
    const caseRow = caseOrSystem;
    const system = systemOrUser;
    const user = typeof userOrMax === "string" ? userOrMax : "";
    const maxTokens = configuredMaxTokens;
    const guarded = await dispatchWithProviderGovernance({
      caseRow,
      workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
      operation: `onboarding-llm-json:${caseRow.id}:${maxTokens}`,
      providerId: "openai",
      dataClass: "candidate-contact",
      dispatch: () => complete(system, user, maxTokens, true),
      disposition: () => "sent",
    });
    if (!guarded.dispatched) return null;
    const resp = guarded.value;
    const text = resp.choices[0]?.message?.content?.trim();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch (err) {
    console.error("[onboarding llm] json completion failed:", err);
    return null;
  }
}
