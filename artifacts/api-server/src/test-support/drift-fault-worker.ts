// Bundled and forked by the drift regression, never by the API entrypoint.
import { pool } from "@workspace/db";
import { POLICY_BENCHMARK, type BenchmarkSelector } from "../lib/hr-policy-benchmark";
import { runPolicyDriftTick, type DriftTestCheckpoint } from "../lib/hr-policy-evaluation";

const [org, stopAt] = process.argv.slice(2);
if (!process.send || !/^drift-fixture-[0-9a-f-]{36}$/.test(org ?? "") ||
    !["reserved", "dispatched", "receipt", "before-finalization", "recover"].includes(stopAt)) {
  throw new Error("Fault worker requires IPC and an explicit fictional fixture tenant.");
}
// A receipt/dispatch count is kept by the surviving parent, not in killed memory.
async function send(message: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
}
async function checkpoint(stage: string) {
  if (stage !== stopAt) return;
  await send({ kind: "checkpoint", stage });
  // Parent uses SIGKILL; no catch/finally or graceful shutdown may settle the run.
  await new Promise<void>(() => {});
}
const transport: BenchmarkSelector = async (question, excerpt, context, _signal, receipt) => {
  await send({ kind: "dispatch", org });
  await checkpoint("dispatched");
  receipt!({ responseId: "fictional-response", resolvedModel: "resolved-a", systemFingerprint: "fp-a",
    promptTokens: 100, completionTokens: 100 });
  await send({ kind: "receipt", org });
  await checkpoint("receipt");
  const c = POLICY_BENCHMARK.find(c => c.question === question && c.source.text === context);
  if (!c) throw new Error("Fake transport received a non-fictional benchmark question.");
  return c.expected.outcome === "supported"
    ? { outcome: "supported", excerptId: "extract-1", quotedText: excerpt }
    : { outcome: c.expected.outcome as "conflicting" | "insufficient" | "injected", excerptId: null, quotedText: null };
};
try {
  // Always supplies fake transport, including recovery. Never starts other workers.
  await runPolicyDriftTick(transport, org, checkpoint as DriftTestCheckpoint);
  await send({ kind: "done" });
} finally {
  await pool.end();
  process.disconnect!();
}
