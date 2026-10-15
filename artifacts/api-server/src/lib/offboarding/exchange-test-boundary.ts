import { AsyncLocalStorage } from "node:async_hooks";
import { externalProviderDispatchDenied, runWithProviderDeny } from "../onboarding/provider-policy";

const identity = new AsyncLocalStorage<{ mailbox: string; members: ReadonlyMap<string, string> }>();
/** Directory/mailbox observations only. Never bypasses app permissions, signed
 * transport, policy, recipient allowlisting, provenance or the provider deny. */
export function withExchangeTestIdentity<T>(input: { mailbox: string; members: Array<[string, string]> }, action: () => T): T {
  if (process.env.NODE_ENV !== "test" || process.env.ONBOARDING_AUTOMATED_TEST !== "true") throw new Error("Isolated test-only identity observations.");
  return runWithProviderDeny(() => identity.run({ mailbox: input.mailbox, members: new Map(input.members) }, action));
}
export function exchangeTestIdentity() {
  return process.env.NODE_ENV === "test" && process.env.ONBOARDING_AUTOMATED_TEST === "true" && externalProviderDispatchDenied() ? identity.getStore() : undefined;
}
