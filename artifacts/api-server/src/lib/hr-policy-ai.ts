import { openai } from "@workspace/integrations-openai-ai-server";
import { dispatchHroAi } from "./hro-context/manager";
import { HrPolicyAiUnavailableError, parsePolicySelection, policySelectionRequest, type PolicyExtractSelection } from "./hr-policy-selection";
export { HrPolicyAiUnavailableError, type PolicyExtractSelection } from "./hr-policy-selection";
export interface PolicyProviderReceipt {
  responseId: string; resolvedModel: string; systemFingerprint: string | null;
  promptTokens: number | null; completionTokens: number | null;
}

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
