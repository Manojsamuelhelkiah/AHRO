import { createHash } from "node:crypto";
import { openai } from "@workspace/integrations-openai-ai-server";
import { dispatchHroAi } from "./hro-context/manager";
import { HrPolicyAiUnavailableError, parsePolicySelection, policySelectionRequest, POLICY_MODEL, POLICY_PROMPT_VERSION, type PolicyExtractSelection } from "./hr-policy-selection";
export { HrPolicyAiUnavailableError, type PolicyExtractSelection } from "./hr-policy-selection";
export { policySelectionRequest as buildPolicySelectionRequest } from "./hr-policy-selection";

export interface PolicyProviderReceipt {
  responseId: string; resolvedModel: string; systemFingerprint: string | null;
  promptTokens: number | null; completionTokens: number | null;
}
export const POLICY_SELECTION_IDENTITY = Object.freeze({
  model: POLICY_MODEL,
  promptVersion: POLICY_PROMPT_VERSION,
  // Bind review to the canonical production request, schema and parameters.
  // Only placeholders, never employee/source text, enter this digest.
  promptDigest: createHash("sha256").update(JSON.stringify(policySelectionRequest("{question}", "{excerpt}", "{sourceContext}"))).digest("hex"),
  outputContractVersion: "policy-extract-selection-1",
});
export type PolicySelectionReceipt = {
  requestedModel: string; resolvedModel: string; providerResponseId: string; systemFingerprint: string | null;
};

/** Only server-created extracts and exact quotations can be returned. */
export async function selectApprovedPolicyExtract(
  question: string, excerpt: string, sourceContext: string, signal?: AbortSignal,
  receipt?: (value: PolicyProviderReceipt) => void,
): Promise<PolicyExtractSelection> {
  let response;
  try {
    response = await dispatchHroAi(policySelectionRequest(question, excerpt, sourceContext),
      request => openai.chat.completions.create(request, { timeout: 30_000, maxRetries: 0, signal }));
  } catch { throw new HrPolicyAiUnavailableError("request_failed"); }
  receipt?.({
    responseId: response.id, resolvedModel: response.model, systemFingerprint: response.system_fingerprint ?? null,
    promptTokens: response.usage?.prompt_tokens ?? null, completionTokens: response.usage?.completion_tokens ?? null,
  });
  return parsePolicySelection(response.choices[0]?.message.content, excerpt);
}
