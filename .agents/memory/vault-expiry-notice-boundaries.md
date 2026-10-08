---
name: Vault expiry notice boundaries
description: Private employee notice channel, identity and authorization constraints
---

Employee expiry reminders belong to the independent signed-in Vault inbox, opt-in by the employee. Do not assume an employer's membership email or an unverified profile email is an authorized private recipient. A future external notification channel requires separately verified recipient binding and dispatch fencing.

**Why:** Employer identity and private employee ownership are intentionally separate. External delivery can leak sensitive checks or grant relationships and uncertain send outcomes can duplicate messages.

**How to apply:** Keep reminder payloads limited to an affected check or grant and recorded expiry, and recheck ownership, preferences, target state and expiry at delivery. A reminder is never verification, renewed consent or reinstated access. Local durable inbox insertion does not require an external effect journal; external sends do.
