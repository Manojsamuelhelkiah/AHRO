# Development Demo job-profile starters

Explicitly invoked only; do not add this operation to startup, deployment, or
post-merge setup. Before running, verify that the shell database and the intended
main development Preview share the same tenant inventory and that `demo` is
`Demo Organization` with slug `demo`.

From the workspace root, in the verified development workspace:

```sh
NODE_ENV=development pnpm --filter @workspace/api-server run provision:demo-job-profiles --preview-host "$REPLIT_DEV_DOMAIN" --confirm-demo
```

The host confirmation is an operator safeguard, not a substitute for checking the
database boundary. Only wholly absent starter IDs are inserted, at version one.
All existing versions, names, contexts and retirement choices are preserved.
Provisioning provenance is recorded in `createdBy` as
`provision:demo-fictional-job-context:v1`.

The five names and role families are Operations (`JP-OPS-1047`), Human Resources
(`JP-HR-1001`), Information Technology (`JP-IT-1001`), Finance (`JP-FIN-1001`),
and Customer Service (`JP-CS-1001`). Other context is deliberately unspecified.
These fictional examples are not policy approvals or execution authority.

Maintain them through **Settings → Workforce & Process Policies → Job profile
catalog**. Existing owner/admin New profile, edit-version and retirement controls
are unchanged. No email request is converted, no case is created or changed, and
no communication is sent by this operation.

Run isolated regression checks with:

```sh
pnpm --filter @workspace/api-server run test:demo-job-profiles
```
