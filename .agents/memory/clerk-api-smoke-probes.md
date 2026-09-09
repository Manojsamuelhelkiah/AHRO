---
name: Clerk API smoke probes
description: Why unauthenticated API readiness probes must not use browser-navigation headers.
---

Send API health and smoke requests with JSON/CORS-style headers rather than HTML navigation headers.

**Why:** In development, Clerk can interpret an unauthenticated request carrying `sec-fetch-mode: navigate` as a browser handshake and return a 307 redirect before the public health route runs. The same localhost endpoint responds normally when probed as an API fetch.

**How to apply:** Keep page probes and API probes separate. Use navigation headers only for HTML pages; use `Accept: application/json` with `sec-fetch-mode: cors` for API readiness and schema checks.