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

Read-only analysis eligibility is separate from activation and provider-disclosure authorization. Accessible curated examples can be analysed as historical evidence, but actual UAT/controller isolation and final provider governance still apply.

**Why:** A body-bearing explanation question was mistaken for a live mutation and returned a misleading retirement error. Removing that classification must not silently authorize a provider request or convert fictional source history into fresh evidence.

**How to apply:** Admit only the supported explanation operation through mutation-oriented fences. Report genuine record or disclosure restrictions explicitly without repeated retry prompts. Keep preparation, activation and workflow start distinct, and require generation provenance for current child evidence; unproven historical snapshots cannot establish readiness.

Read-only explanations use current reviewed disclosure decisions, not an operational adoption/rebase requirement on the historical case. They must not automatically approve provisional provider-governance decisions.

**Why:** Curated offline examples share an operational retirement flag; routing explanation requests through ordinary message-dispatch checks incorrectly treats reading as live activation. After separating that classification, genuine current disclosure reviews can still block the model request.

**How to apply:** Constrain the exception to exact server-owned explanation generation/verification operations, retain fresh case-analysis and actual UAT/controller isolation checks, and return the specific server-generated denial rather than an umbrella error. Separate AI-analysis policy approval from employee messaging only through explicit product authorization.