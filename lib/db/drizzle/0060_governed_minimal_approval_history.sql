-- Legacy immutable approval snapshots remain opaque/retention-blocking.
-- New append-only rows can explicitly identify the server-owned minimal
-- decision projection; no historical row is rewritten.
ALTER TABLE "onb_approval_history"
  ADD COLUMN IF NOT EXISTS "projection_kind" text NOT NULL DEFAULT 'legacy';