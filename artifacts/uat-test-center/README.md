# UAT Test Center

Entry URL: **`/uat/`**. Catalog/run deep links use `/uat/?run=…`,
policy quality uses `/uat/policy-quality`, fairness uses `/uat/fairness`.
Historical Control Tower `/uat-test-center` links show a relocation screen only.
Demo Center and Learning Guide remain in Control Tower.

## Authentication and operation

This app uses the existing Clerk identity directory and shared API/database.
The existing `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` configuration still applies. Pass through
`VITE_CLERK_PROXY_URL` where the existing deployment requires its Clerk proxy;
do not hardcode credentials or a production hostname. Host-dependent
publishable-key resolution is the same as Control Tower.

Serve the app and API on the **same HTTPS origin**. The managed API service owns
both `/api` and `/uat/api`; UAT clients use `/uat/api`. Admission cookies are
always Secure, HttpOnly, host-only, SameSite=None (for the preview iframe).
Cross-origin browser reads and non-same-origin mutations are rejected.
No new signing secret is needed: cookies contain random 256-bit opaque
capabilities, stored only as SHA-256 hashes in the database.
Apply the checked-in `0105_uat_admission` migration through `db:reconcile`
before serving this version; production's existing migration safeguards apply.

UAT first creates a 10-minute, single-use server challenge, then requires a
**new non-ticket Clerk sign-in**. The server checks the live session, its
creation after the challenge, the client's active session and authentication
strategy, and actual active application membership. An already active
Control Tower session, a demo ticket or development administrator principal
is insufficient. The UI warns before ending the shared Clerk session to
start a fresh sign-in; other tabs may need to sign in again.

Admission lasts at most 30 minutes and is bound to user, Clerk session and one
workspace. Every protected request revalidates the Clerk session and actual
membership. Workspace changes require fresh admission. Logout revokes only
UAT's opaque admission; it does not delete evidence or sign out Clerk.
Per-tab workspace selectors are convenience values, never authorization.
Queries/caches are recreated for each admission and cleared on exit; tab exit
is broadcast immediately and requests always retain their page-pinned scope.
Revocation, expiry and scope rejection cannot grant professional authority,
model-spending consent or permission for external delivery.

## Checks

```sh
pnpm --filter @workspace/api-spec codegen
pnpm run typecheck
pnpm --filter @workspace/uat-test-center test
TEST_FILE=src/lib/uat-admission.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs
pnpm exec playwright test --config=playwright.uat.config.ts
```

The browser regression uses a disposable migrated PostgreSQL schema and the
real domain routes, admission router/store and membership checks. Only the
external Clerk provider is replaced by a test-process credential adapter.
It does not prove that a particular live OAuth/password provider is configured;
the managed Clerk setup must allow the existing users' supported sign-in
method and `/uat/sign-in` callbacks. Test adapters cannot be enabled in a
production build or imported by the production API server. External providers
are denied in the isolated regression and no model calls or real emails run.
