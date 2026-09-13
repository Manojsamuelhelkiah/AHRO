import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertAutomaticMigrationIsSafe, loadCheckedInMigrations } from "./test-db-setup.mjs";

test("reviewed transfer migrations are accepted only for their exact contents", async () => {
  const migrations = (await loadCheckedInMigrations()).filter(({ tag }) =>
    /^008[3-8]_workforce_transfer_/.test(tag),
  );
  assert.equal(migrations.length, 6);
  for (const migration of migrations) {
    assert.doesNotThrow(() => assertAutomaticMigrationIsSafe(migration), migration.tag);
    const statements = [...migration.statements, 'DROP TABLE "organizations"'];
    const changedHash = createHash("sha256").update(statements.join(";\n")).digest("hex");
    assert.throws(
      () => assertAutomaticMigrationIsSafe({ ...migration, hash: changedHash, statements }),
      /refused destructive or unsupported migration/,
      migration.tag,
    );
  }
});