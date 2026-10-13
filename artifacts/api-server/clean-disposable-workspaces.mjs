import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { reviewedDisposableWorkspaces as manifest } from "./disposable-workspaces.mjs";
import { cleanupWorkspaces, inventoryWorkspaces } from "./workspace-cleanup.mjs";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
if (args.length && !apply && args[0] !== "--dry-run") throw new Error("Use --dry-run or --apply <explicit IDs>");
if (process.env.NODE_ENV === "production") throw new Error("Development maintenance only");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  console.log(JSON.stringify({ inventory: await inventoryWorkspaces(pool, manifest) }, null, 2));
  if (apply) {
    console.log(JSON.stringify(await cleanupWorkspaces(pool, {
      ids: args.slice(1), manifest,
      snapshotPath: fileURLToPath(new URL(
        `../../generated-artifacts/private-workspace-cleanup/recovery-${Date.now()}.json`, import.meta.url)),
    }), null, 2));
  }
} finally { await pool.end(); }
