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