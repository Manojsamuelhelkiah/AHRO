// Compatibility tombstone: do not import DB, bootstrap tenants, or seed records.
console.error("CASE_TEST_CAPABILITY_RETIRED: Case seeding has been retired. Existing history is read-only.");
process.exitCode = 1;
