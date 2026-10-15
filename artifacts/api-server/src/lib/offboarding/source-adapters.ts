import { z } from "zod";
import { Correlation, TaskId } from "./exchange-contract";
import { SourceHandling } from "./source-handling";

export const InterfaceRequest = z.object({
  correlation: Correlation,
  provider: z.enum(["entra", "servicenow"]),
  operation: z.enum(["read-access-inventory", "reassign-shared-account", "confirm-kt-handling", "disable-access", "read-equipment-inventory", "confirm-return"]),
  sourceReferences: z.array(z.string().min(1).max(160)).max(30),
  expected: z.array(z.string().min(1).max(80)).max(30),
  notBeforeAt: z.string().datetime().nullable(),
}).strict();
export const InterfaceResponse = z.object({
  correlation: Correlation, provider: z.enum(["entra", "servicenow"]), mode: z.literal("simulated"),
  receiptType: z.literal("simulated-api-response"), sourceReference: z.string().max(200),
  status: z.enum(["pending", "partial", "confirmed", "exception"]),
  confirmed: z.array(z.string().max(80)).max(30), outstanding: z.array(z.string().max(160)).max(30),
  handling: SourceHandling.optional(),
}).strict();
/** Pure, correlated adapters: no SDK, credentials, HTTP or live mutation path exists. */
export function mockSourceStatus(raw: unknown, scenario: "success" | "delayed" | "exception", clock: string) {
  const request = InterfaceRequest.parse(raw), task = TaskId.parse(request.correlation.taskId);
  if ((task.startsWith("asset-") ? "servicenow" : "entra") !== request.provider) throw new Error("Provider/task mismatch.");
  const expectedOperation: Record<typeof task, typeof request.operation> = {
    "access-inventory": "read-access-inventory", "shared-accounts": "reassign-shared-account", "kt-access-exception": "confirm-kt-handling",
    "access-closure": "disable-access", "asset-inventory": "read-equipment-inventory", "asset-return": "confirm-return",
  };
  if (request.operation !== expectedOperation[task]) throw new Error("Unsupported offboarding operation.");
  const early = request.notBeforeAt !== null && Date.parse(clock) < Date.parse(request.notBeforeAt);
  const delayed = scenario === "delayed" && task === "asset-return";
  const exception = scenario === "exception" && (task === "asset-return" || task === "shared-accounts");
  const confirmed = early || delayed ? [] : exception ? request.expected.filter(v => v !== "charger" && v !== "shared account") : request.expected;
  return InterfaceResponse.parse({ correlation: request.correlation, provider: request.provider, mode: "simulated",
    receiptType: "simulated-api-response", sourceReference: `${request.provider}:${request.correlation.reference}`,
    status: early || delayed ? "pending" : exception ? "exception" : "confirmed",
    confirmed, outstanding: request.expected.filter(v => !confirmed.includes(v)),
    ...(confirmed.length && task === "shared-accounts" ? { handling: { sharedAccountOwner: "Account custodian" } } : {}),
    ...(confirmed.length && task === "kt-access-exception" ? { handling: { ktRequired: false } } : {}),
  });
}
