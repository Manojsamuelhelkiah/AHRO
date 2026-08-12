---
name: Reasoning model token budget
description: gpt-5 family via Replit AI proxy returns empty content if max_completion_tokens is small
---
Reasoning models (e.g. gpt-5-nano via the Replit AI integrations proxy) spend completion tokens on hidden reasoning first. With a small `max_completion_tokens` (~a few hundred) they finish with `finish_reason: "length"` and **empty content**.

**Why:** observed in practice — LLM calls silently returned null until the budget was raised.

**How to apply:** always add a generous buffer (~+2500 tokens) on top of the desired output size for any gpt-5-family chat completion, and treat empty content + finish_reason "length" as a budget problem, not an API failure.
