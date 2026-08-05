---
name: Merge-marker false positives
description: Long equal-sign comment banners are flagged as conflict markers by the rebase resolution checker
---
Rule: avoid `// =======`-style banner comments; use dashes instead.
**Why:** continueMergeResolution scans for `=======` and rejects files containing equal-sign banner lines even when no real conflict remains.
**How to apply:** when writing or merging files with section banners, use `---` runs; if the checker complains, sed the banners to dashes.
