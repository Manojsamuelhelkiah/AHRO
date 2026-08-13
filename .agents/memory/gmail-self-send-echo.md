---
name: Inbound polling echo loops
description: Any agent that both sends and polls the same mailbox/channel can reply to its own messages forever.
---

An agent that polls a channel for inbound messages while also sending on that channel can ingest its own outbound messages as "inbound" and reply to itself in an endless loop — especially when the counterpart's address is the same account (demo/self-send setups). Sender-address or label filtering cannot distinguish the two.

**Why:** self-sent messages match the same search criteria as genuine replies.

**How to apply:** dedupe inbound ingestion by provider message id, and record the provider id of every outbound send in that same dedup set so the agent's own messages are skipped automatically.
