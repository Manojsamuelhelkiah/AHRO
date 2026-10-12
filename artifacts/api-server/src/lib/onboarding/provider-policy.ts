import { AsyncLocalStorage } from "node:async_hooks";

const providerPolicy = new AsyncLocalStorage<{ denyExternalProviders: boolean }>();

/** Execute a bounded operation while prohibiting all external delivery. */
export function runWithProviderDeny<T>(operation: () => T): T {
  return providerPolicy.run({ denyExternalProviders: true }, operation);
}

/** No nested scope can reopen this fence. */
export function externalProviderDispatchDenied(): boolean {
  return providerPolicy.getStore()?.denyExternalProviders === true;
}
