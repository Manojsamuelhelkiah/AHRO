// Preserve the commercial smoke's assertions without using Preview/shared data.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createIsolatedTestDatabase } from "../artifacts/api-server/isolated-test-database.mjs";

if (process.env.NODE_ENV === "production") throw new Error("Smoke validation cannot run in production");
const owned = await createIsolatedTestDatabase(process.env.DATABASE_URL, "intent_smoke");
let server;
let child;
let exitCode = 1;
const interrupt = () => child?.kill("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  process.env.DATABASE_URL = owned.connectionString;
  process.env.NODE_ENV = "development";
  process.env.API_VALIDATION_MODE = "true";
  // Import only after isolation is established. Do not start the normal index
  // or its workers, bind a case, or attach to a possibly shared API process.
  const [{ default: app }, { runWithProviderDeny }] = await Promise.all([
    import("../artifacts/api-server/src/app.ts"),
    import("../artifacts/api-server/src/lib/onboarding/provider-policy.ts"),
  ]);
  server = createHttpServer((req, res) => runWithProviderDeny(() => app(req, res)));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const apiUrl = `http://127.0.0.1:${server.address().port}`;
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const webUrl = `http://127.0.0.1:${reservation.address().port}`;
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  child = spawn(process.execPath, ["artifacts/cost-explorer/scripts/intent-routing-smoke.mjs"], {
    stdio: "inherit",
    env: {
      ...process.env,
      INTENT_ROUTING_SMOKE_BASE_URL: apiUrl,
      INTENT_ROUTING_SMOKE_API_URL: apiUrl,
      INTENT_ROUTING_SMOKE_WEB_URL: webUrl,
      INTENT_ROUTING_SMOKE_OWNED_SCHEMA: owned.schema,
    },
  });
  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  if (server) await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  await owned.dispose();
}
process.exit(exitCode);
