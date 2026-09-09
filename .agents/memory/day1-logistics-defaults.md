---
name: Day-1 logistics defaults
description: Durable semantics for tenant defaults, existing-case backfills, and per-case edits
---

Every onboarding case must have Day-1 logistics. Backfill existing cases that have no logistics, and copy the current tenant-wide editable default into every future case. A later change to the tenant default applies to future cases only; it must not overwrite case-specific logistics already copied or edited.

**Why:** the user confirmed that synthetic out-of-box logistics should be available across all existing and future cases as an editable default. Snapshotting preserves local HR edits and prevents a later tenant-default change from silently changing instructions already prepared for a hire.

**How to apply:** keep logistics separate from checklist snapshots. Use a clearly synthetic default for new/demo tenants, resolve a blank default orientation date to the case joining date, backfill only missing rows, and continue to allow HR to edit each case independently. Do not assume migration data inserts reached production through Publish: initialize a missing case snapshot idempotently at the application boundary as well.