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