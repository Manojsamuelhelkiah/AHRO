---
name: Multi-estate connector modes
description: Safety rule for mapping multiple payroll or ticketing estates onto connector-wide watcher state.
---

Payroll and ticketing can have multiple mapped estates with separate stable identities. Any watcher-capable instances for the same system type must resolve to one identical connector-wide tracking mode and connection status.

**Why:** Watcher configuration is still stored per connector, not per estate. Allowing instances to choose different modes would make activation order-dependent and could silently enable or disable the wrong tracking behavior.

**How to apply:** Validate agreement before persistence and activation, and collapse matching estate selections into one connector update. Only relax this rule after watcher state itself becomes instance-scoped.