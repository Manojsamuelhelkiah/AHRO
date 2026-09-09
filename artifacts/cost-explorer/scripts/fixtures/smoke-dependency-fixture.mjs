import { appendFileSync, writeFileSync } from "node:fs";

const [mode, readyFile, lifecycleFile] = process.argv.slice(2);
appendFileSync(lifecycleFile, `started:${process.pid}\n`);

const cleanup = () => {
  appendFileSync(lifecycleFile, `stopped:${process.pid}\n`);
  process.exit(0);
};
process.once("SIGTERM", cleanup);
process.once("SIGINT", cleanup);

if (mode === "exit") {
  console.error("fixture failed before readiness");
  process.exit(23);
}

if (mode === "ready") writeFileSync(readyFile, "ready");
setInterval(() => {}, 1_000);