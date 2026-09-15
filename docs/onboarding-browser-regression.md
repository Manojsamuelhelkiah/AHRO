# Durable onboarding browser regression

`pnpm test:browser-regression` runs the release regression for the complete
Demo Administrator presenter journey:

1. Starts a standalone API harness that mounts the actual API router and uses
   a test-only, allow-listed Demo Administrator/Demo Reviewer session adapter.
2. Starts the real onboarding-agent Vite application with a browser-regression
   Clerk adapter. This adapter replaces only the browser-side Clerk session;
   the production Clerk integration and production auth paths are unchanged.
3. Creates a unique offline synthetic case through the real `POST
   /api/onboarding/cases` route.
4. Simulates exactly one exchange through the real simulation route, reloads,
   checks the persisted exchange, and checks the explicitly simulated
   Communications and Activity tabs.
5. Checks the simulation control at 390px, 768px, and 1280px viewports.
6. Opens the same case as Demo Reviewer and verifies that the simulation
   control is absent.

The API harness is not a production auth bypass. It requires
`ONBOARDING_E2E_TEST=true`, creates a random disposable PostgreSQL schema,
initializes that schema from the checked-in Drizzle migrations, and refuses to
start unless its core relations resolve from that schema. The scoped database
pool is created before the API router is imported, with only the isolated
schema in `search_path`; it never falls back to public/shared application
objects. The harness exposes the one pgcrypto digest overload needed by the
checked-in custody migration through a function shim in the disposable schema.
Startup failures and SIGTERM/SIGINT cleanup use `try/finally` to close pools
and drop only this owned schema. No immutable audit rows in a shared schema
are used or deleted. The harness creates unique fixture principals and places
an HttpOnly test session in front of the normal router `requireAuth` and tenant
membership middleware.

The harness also wraps every request in the server-side
`runWithProviderDeny` execution fence. The browser test separately fails if a
request leaves the local harness origin, but that interception is only an
additional signal: provider safety is enforced in the API process.

Fixtures are server-marked with the same synthetic-offline marker used by the
production workers, have no candidate contact authorization, and are cleaned
up by dropping the owned schema on harness shutdown. The harness starts no
background workers. Do not replace schema isolation with shared-schema
fixtures: even an offline case can generate audit outbox records that another
process could later deliver.

The Clerk boundary is intentional: this regression does not exercise Clerk's
hosted UI, device verification, or a real Clerk secret. Hosted Clerk
availability requires a separate authentication check. This test still
exercises the real app pages, real cookies, real tenant/profile checks, real
database persistence, and real provider-deny boundary.

## Local setup

The first run may need the Playwright Chromium binary:

```sh
pnpm exec playwright install chromium
pnpm test:browser-regression
```

No application secrets are required by the test. `DATABASE_URL` is required,
because this is deliberately a durable database-backed regression rather than
a mocked API test.

The test starts Vite directly with `--host 127.0.0.1`; it does not use the
workspace dev script's public `--host 0.0.0.0` override. The browser API and
Vite server both bind to loopback, and test-mode Vite allows only localhost
hosts.