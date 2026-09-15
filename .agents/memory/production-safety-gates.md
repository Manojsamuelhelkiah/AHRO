---
name: Production safety gates
description: How to enforce checks that must pass against the published environment after each Replit publish.
---

Replit does not provide a dedicated post-deploy command hook. Safety checks that
must run against production after every publish should execute at production
startup before the application imports or begins listening. A failed check must
exit non-zero so deployment logs expose it and the startup health check cannot
mark the new production instance healthy.

**Why:** Build commands do not have the published runtime database context, while
a manual post-publish command can be forgotten. Production startup has the
correct environment and is part of every publish.

**How to apply:** Keep the check read-only, log a clear trust decision, and fail
closed before serving traffic. Unit-test both call ordering and the production
service command so configuration drift cannot bypass the gate.

Production database gates must bound both connection acquisition and every
statement independently. Configure PostgreSQL's server-side statement timeout
and retain a client-side deadline so driver or network stalls also fail closed.
Use parameter-safe `set_config` rather than placeholders in a `SET` statement.

**Why:** A degraded connection can otherwise leave a publish pending forever,
and PostgreSQL does not accept a bound parameter in `SET statement_timeout`.

**How to apply:** Emit a clear "production is not trusted" timeout error, discard
clients with timed-out queries, and test never-resolving connection and query
promises without relying on production access.

Startup gates should attach stable, machine-readable reason categories to
blocked-release errors while keeping the human trust decision in the message.
The gate's own deadline must win over driver timeouts, or equivalent failures
can escape without the expected category.

**Why:** Operators and alerting need to distinguish connection stalls, statement
stalls, and safeguard mismatches without parsing database errors or exposing
connection details.

**How to apply:** Keep categories coarse and credential-safe, include them in the
operator-facing startup line, and unit-test both the category property and clear
fail-closed wording for every supported reason.

Bound the entire verification phase, including cleanup, below the platform's startup window; per-query timeouts alone are insufficient. Emit credential-free stage timing and stop on missing schema before querying dependent tables.

**Why:** A publish built successfully but was killed after roughly one minute while verification was silent. Sequential query budgets could exceed that window, and production lacked newly merged transfer tables.

**How to apply:** Preserve the no-serving-before-verification rule, discard timed-out clients, prevent late completion from starting the API, and confirm the current development-to-production schema diff before retrying Publish.

Treat procedural custody objects as a separate Publish readiness requirement;
table/column parity and migration ledgers do not prove triggers or extension
functions exist in production.

**Why:** Production catalog inspection found transfer custody functions,
triggers, and pgcrypto absent even when Publish reported an empty schema diff.
An empty structural diff is not evidence that procedural objects were promoted.
No post-Publish procedural installation was verified.

**How to apply:** Verify live catalogs read-only before serving, including
definitions and actual name resolution. If Publish omits them, keep the release
blocked and use operator/platform administration, never startup/build DDL.

Temporarily starting the bundled API directly was confirmed to let Autoscale
publish while these objects remained absent. Treat that as proof that the
startup gate was blocking promotion, not as resolution of the trust failure.

**Why:** The direct-start workaround produced a successful public deployment,
but a production catalog recheck still showed all required procedural objects
missing.

**How to apply:** Prioritize production database reconciliation, keep the
workaround explicitly temporary, and restore guarded startup immediately after
the live catalog passes verification.