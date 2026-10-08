---
name: HR policy grounding boundaries
description: Why policy answers use approved extracts and remain separate from case explanations
---

Keep approved policy guidance separate from case evidence and operational checklist policy. Policy review must use independently verified governance authority, not tenant membership or owner-managed case assignments.

**Why:** A case record proves what was recorded for that case; it cannot establish an organization's current approved guidance. Administrative access likewise does not establish professional review authority.

Use extractive answers for the initial policy assistant, with the full authorized source available to check qualifications and contradictions. Never equate a matching sentence with a supported answer.

**Why:** A plausible generated paraphrase can introduce legal or benefit claims absent from the approved source, and an isolated sentence can omit a disqualifying exception elsewhere in the same policy.

**How to apply:** Filter membership, audience, applicability, publication and freshness before model disclosure; reauthorize after model completion and when opening citations. Preserve explicit limitations instead of using general knowledge or an older source as fallback.

Separate durable reminder persistence from transactions holding membership or authority locks; reauthorize before returning reminder contents.

**Why:** Policy lifecycle operations do not share a single authority/version lock order. Reminder foreign-key checks also lock parent versions, so adding reminder writes to an authorization transaction can introduce a deadlock even without explicit version locking.

**How to apply:** Authorize first, persist separately without authority locks, then reauthorize and read current lifecycle/audience/date state. A durable stale reminder must not imply current access or continued publication.

Treat answer-quality benchmarking as roadmap assurance, not a current accuracy guarantee. A synthetic answer key checked into code is a review proposal until a business reviewer approves it; scripted contract replay is not model accuracy.

**Why:** The business-user explainer distinguishes implemented quotation controls from systematic answer-quality assurance. Exact quotations can still be irrelevant or misleading, and agent-authored expectations cannot certify their own business correctness.

**How to apply:** Keep reviewed ground truth separate from CI/provider stubs. Require explicit authorized, bounded real-model operations using only fictional content; never silently spend provider budget on builds or policy publication.