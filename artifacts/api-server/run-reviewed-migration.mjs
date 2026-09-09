import {
  applyReviewedMigration,
  loadCheckedInMigrations,
  reviewedMigrationApproval,
} from "./test-db-setup.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const tag = option("--migration");
if (!tag) {
  throw new Error(
    "Usage: pnpm run db:migrate:reviewed -- --migration <tag> --approve <approval>",
  );
}

const migrations = await loadCheckedInMigrations({
  allowReviewedDestructive: true,
});
const migration = migrations.find((candidate) => candidate.tag === tag);
if (!migration) {
  throw new Error(`Reviewed migration runner cannot find migration ${tag}`);
}

console.log(`Reviewed migration selected: ${migration.tag}`);
console.log(`Migration SHA-256: ${migration.hash}`);
console.log(`Statements to execute: ${migration.statements.length}`);

const approval = option("--approve");
const expectedApproval = reviewedMigrationApproval(migration);
if (approval !== expectedApproval) {
  throw new Error(
    `Execution refused. After review, rerun with --approve '${expectedApproval}'`,
  );
}

await applyReviewedMigration({ tag, approval });
console.log(`Reviewed migration applied: ${migration.tag} (${migration.hash})`);