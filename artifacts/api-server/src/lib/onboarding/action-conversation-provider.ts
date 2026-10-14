import { externalProviderDispatchDenied } from "./provider-policy";
import { evaluateProviderGovernanceGate, PROVIDER_GOVERNANCE_WORKFLOW, type ProviderGovernanceCase } from "./governance-provider-boundary";
import { evaluateSensitiveLifecycleGate, jurisdictionForWorkforceContext, SENSITIVE_DATA_CLASSES } from "./sensitive-lifecycle";

/** Disclosure check only: never calls a provider, tool, or effect dispatcher. */
export async function assertConversationProviderDisclosure(row: ProviderGovernanceCase) {
  if (externalProviderDispatchDenied()) throw new Error("Provider disabled");
  const gate = await evaluateProviderGovernanceGate(row, PROVIDER_GOVERNANCE_WORKFLOW.communication);
  if (!gate.allowed) throw new Error("Provider approval unavailable");
  for (const dataClass of SENSITIVE_DATA_CLASSES) {
    const lifecycle = await evaluateSensitiveLifecycleGate({
      organizationId: row.organizationId, jurisdiction: jurisdictionForWorkforceContext(row.workforceContext),
      dataClass, providerId: "openai", disclosure: true,
    });
    if (!lifecycle.allowed) throw new Error("Provider disclosure unavailable");
  }
}
