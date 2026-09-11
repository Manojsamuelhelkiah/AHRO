import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Bounded, separate sessions for work that must hold a PostgreSQL advisory
// lock while the regular application pool performs nested queries.
export const bgvNotificationLockPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 32,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  allowExitOnIdle: true,
});
export const db = drizzle(pool, { schema });

export * from "./schema";
