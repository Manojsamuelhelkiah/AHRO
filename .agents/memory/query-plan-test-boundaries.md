---
name: Query plan test boundaries
description: Distinguish index capability checks from real workload planner benchmarks.
---

An index-capability regression must not depend on the cost planner preferring an ordered index for a tiny newly inserted tenant fixture.

**Why:** PostgreSQL can legitimately prefer a competing tenant index plus a small sort, even with all required ordering indexes present. Shared development statistics and fixture size influence that choice, independently of runtime correctness.

**How to apply:** For structural probes, discourage alternate sort and scan strategies within the test-only transaction and assert that the intended index supports the ordering. Keep real planner preference and performance benchmarks separate and representative; never change production planner settings to satisfy a test.
