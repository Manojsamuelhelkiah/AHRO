---
name: Secure App Storage uploads
description: Security constraints for untrusted file uploads when using Replit App Storage.
---

The local App Storage signed-URL service signs only the destination host; extra requested content-length or content-type headers are not included in the signature. Do not treat those URLs as enforcing actual upload bytes, and do not expose them for untrusted security-sensitive uploads that require hard limits.

**Why:** Declared quotas cannot prevent an unrestricted signed PUT from uploading oversized bytes, replaying within its validity window, or replacing bytes between validation and promotion.

**How to apply:** Route untrusted uploads through an authenticated endpoint that enforces the actual byte count before writing to private App Storage. Persist a one-time lifecycle record and use the same database row as a fence for writers and cleanup workers; reserve object paths durably before storage operations.

Bounded-upload verification must exercise real multipart requests, not only the service that receives an already-parsed buffer.

**Why:** The installed multipart parser's part-budget accounting can reject a valid browser upload even while byte/type and lifecycle service tests pass. A fail-closed transport that rejects every supported file is still broken functionality.

**How to apply:** Keep a transport-level acceptance fixture alongside oversized, extra-file and extra-field rejection fixtures when adding or changing an upload endpoint.