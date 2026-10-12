# Controlled Demo offline inventory

The approved exception adds **60 new rows**, five per current Control Tower
family, to the existing **Demo Organization** only. It does not replace earlier
examples, modify evidence, grant authority, or restore retired product controls.

From `artifacts/api-server`, run only when explicitly authorized:

```sh
NODE_ENV=development node run-offline-examples.mjs add-60-offline-examples-to-demo
```

The command verifies the existing tenant ID, slug and name. It never bootstraps
a tenant. Fixed new slot identities and a transaction lock make retries and
concurrent attempts converge on the same inventory; conflicting stored data
stops the operation rather than repairing or replacing it.

All offline fences are inserted with each parent before it becomes visible.
No approval, communication, event, logistics, external-operation or completed
evidence rows are provisioned. Details are pending review, not execution plans.

Active, registered Demo profiles receive exact case-scoped read grants for
fictional offline examples (including retained older examples). These use the
ordinary access evaluator and cannot override denies or reactivate revoked
grants. They grant no sensitive-identity permission, editing, tool use or
professional authority. Real-person/hybrid contacts remain excluded.

The count-only result also verifies worker, provider and decision-authority
denials and preservation of existing cases. This command has no HTTP route,
Settings button, startup hook or published-environment mode. Its development
result says nothing about the published database.
