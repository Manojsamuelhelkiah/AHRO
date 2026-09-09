import { AsyncLocalStorage } from "node:async_hooks";

type ProviderPolicy = { denyExternalProviders: boolean };

const providerPolicy = new AsyncLocalStorage<ProviderPolicy>();

/** Execute a bounded operation while prohibiting all external delivery. */
export function runWithProviderDeny<T>(operation: () => T): T {
  return providerPolicy.run({ denyExternalProviders: true }, operation);
}

/** Checked immediately before an email, WhatsApp, or voice provider dispatch. */
export function externalProviderDispatchDenied(): boolean {
  return providerPolicy.getStore()?.denyExternalProviders === true;
}