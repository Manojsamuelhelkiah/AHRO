---
name: Context retention boundaries
description: Why metadata retention uses conservative holds and does not infer abandoned work.
---

Do not add a reversible subject lookup solely to narrow retention holds. Opaque continuity metadata uses conservative tenant-wide hold protection, including sensitive-lifecycle and audit legal holds.

**Why:** A case/object/class hold cannot safely be matched from one-way subject hashes, especially after the underlying case is removed. Adding personal subject mappings just for cleanup would expand the metadata manager's privacy scope.

**How to apply:** Accept conservative retention while any applicable tenant hold exists. Any future narrower hold mapping needs an explicit privacy review, not a guessed hash or a missing-record assumption.

Do not declare an unfinished execution abandoned merely because it is old or blocks pruning.

**Why:** Context status is not the domain recovery authority; an interrupted provider effect or workflow can remain unresolved after its worker stops. Removing its links or fabricating a terminal outcome would conceal that uncertainty.

**How to apply:** Preserve unfinished chains until a separately governed domain recovery/disposition establishes a terminal state. Oversized chains need separate reviewed handling rather than partial deletion that leaves broken correlation links.
