import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";

export type FaultStage = "reserved" | "dispatched" | "receipt" | "before-finalization";
type Message = { kind: string; stage?: string; org?: string };

export async function buildDriftFaultWorker() {
  // Keep the bundle inside the package so external pg/pino resolve normally.
  const directory = await mkdtemp(path.resolve(".drift-fault-"));
  const workerPath = path.join(directory, "worker.mjs");
  try {
    const { build } = createRequire(import.meta.url)("esbuild");
    await build({
      entryPoints: [path.resolve("src/test-support/drift-fault-worker.ts")],
      outfile: workerPath, bundle: true, platform: "node", format: "esm", target: "node20",
      external: ["node:*", ...builtinModules, "pg", "pino", "pino-pretty", "thread-stream", "@replit/connectors-sdk"],
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
    return { workerPath, dispose: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function runDriftFaultWorker(workerPath: string, org: string, stage: FaultStage | "recover") {
  const child = fork(workerPath, [org, stage], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const messages: Message[] = [];
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  await new Promise<void>((resolve, reject) => {
    let killedAtCheckpoint = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Drift worker timed out at ${stage}: ${stderr}`));
    }, 30_000);
    child.on("message", (value: Message) => {
      messages.push(value);
      if (value.kind === "checkpoint" && value.stage === stage) {
        killedAtCheckpoint = true;
        child.kill("SIGKILL");
      }
    });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (stage === "recover" ? code === 0 && messages.some(m => m.kind === "done")
        : killedAtCheckpoint && signal === "SIGKILL") resolve();
      else reject(new Error(`Drift worker exited unexpectedly at ${stage} (${code}, ${signal}): ${stderr}`));
    });
  });
  return messages;
}
