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

Treat provider identity changes as a new human-review question even when the fixed synthetic answer key still passes. Never automatically promote a changed provider run to the reviewed baseline.

**Why:** Passing a small fictional pack cannot establish that an aliased model's behavior is unchanged outside those cases. Missing fingerprints likewise cannot prove implementation stability.

**How to apply:** Keep recurring-check consent separate from answer-key approval, bind it to the exact reviewer authority, and pause for investigation rather than silently accepting replacement behavior.

Language-pair consistency is not correctness or broad fairness assurance. Equal wrong answers must fail, and audience/date blocks must not inflate measured model-language agreement. Translations remain business-review proposals until independently approved.

**Why:** Shared abstentions may reflect a safety gate rather than model understanding; equally unsupported citations can look consistent while still misleading users.

**How to apply:** Bind paired questions to identical fictional evidence and answer keys, score agreement separately from correctness, and distinguish model-required pairs from pre-disclosure gates and scripted replay.

Keep policy document extraction local and separate from model-assisted guidance. Do not work around unavailable private scanning by sending policy files to a public scanner or remote OCR/extraction provider.

**Why:** HR policies can contain confidential organizational information; accepting uploads does not authorize another processor or establish source authenticity. A scan/extraction result must not bypass the independent review already required for guidance.

**How to apply:** Treat any future OCR or external document processor as a separately approved privacy/processing decision. Preserve the authoritative source provenance when maintainers correct extracted text.