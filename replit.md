# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Production background pollers need a heartbeat**: the published app runs on autoscale, so the in-process pollers (system watcher, watch-mailbox tracker, Gmail reply monitor) pause when no HTTP request is in flight — health checks and outage alerts stop off-hours. `GET|POST /api/onboarding/webhooks/watcher-tick` (idempotent; DB-backed throttle of 1 tick/5s shared across instances; optionally authenticated — set the `WATCHER_TICK_TOKEN` secret and callers must send it via `x-watcher-token` header or `?token=`) runs one round of all three pollers and awaits any in-flight poll before responding. Keep it hit every 1–5 min in production: either a Replit Scheduled Deployment (or any external cron/uptime pinger) running `node scripts/watcher-heartbeat.mjs`, or republish the app as a Reserved VM (always-on) so the intervals never pause.

- **Twilio WhatsApp inbound webhook**: the WhatsApp sandbox sender (`whatsapp:+14155238886`) is configured to POST incoming messages to `https://hro-agent-nexus.replit.app/api/onboarding/webhooks/twilio/whatsapp`. If the deployment domain ever changes, update the sender's webhook via the Senders API:
  ```bash
  curl -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" -X POST \
    "https://messaging.twilio.com/v2/Channels/Senders/XE2c300bbf327c4995bd0df1e9f11f0b35" \
    -H "Content-Type: application/json" \
    -d '{"webhook":{"callback_url":"https://<NEW_DOMAIN>/api/onboarding/webhooks/twilio/whatsapp","callback_method":"POST"}}'
  ```
  (or in the Twilio Console under Messaging → Try it out → WhatsApp sandbox settings, "When a message comes in"). The endpoint validates `X-Twilio-Signature`, so it only accepts requests signed with `TWILIO_AUTH_TOKEN` for the exact public URL.
- `TWILIO_WHATSAPP_FROM` must be the sandbox sender `whatsapp:+14155238886` — outbound sends fail if it's set to any number not registered as a WhatsApp sender on the Twilio account.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
