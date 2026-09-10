---
name: Case explanation boundaries
description: Product and safety decisions for conversational explanations of onboarding actions.
---

Explain recorded decision factors and source evidence, not an agent's private internal reasoning. Distinguish human decisions from AI actions and current state from historical rationale.

**Why:** A present-day policy or status does not establish why an earlier decision was made. A valid citation identifier alone also does not establish that its source supports an AI-written claim.

**How to apply:** Use fresh case-scoped records, check claims against their cited excerpts, and say when the historical reason is unavailable. Treat records and chat history as untrusted content, never execution instructions or independent proof. Explanations remain read-only and cannot grant approval authority.

Use native strict structured output for evidence-constrained replies, not merely a JSON-object response format.

**Why:** Live completions can be valid JSON yet violate the citation contract; excessive reasoning can also exhaust a nominally generous output budget before producing the answer. Mocked JSON tests do not expose either failure.

**How to apply:** Constrain known citation IDs in the output schema, retain application-side validation and evidence checks, and verify one real response with bounded reasoning and cancellation. Log failure stage and finish reason rather than case text.

Conversation continuity must not cross case, authenticated-user, or organization boundaries.

**Why:** Changing a cache key alone does not reset mounted React state or stop an old request from completing into another case's conversation.

**How to apply:** Reset or remount at scope boundaries, cancel outstanding requests, and fence late callbacks, including after Clear Chat. Avoid persistent browser storage of sensitive case conversations unless separately designed and authorized.