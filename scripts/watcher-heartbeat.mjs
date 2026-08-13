#!/usr/bin/env node
/**
 * Production heartbeat for the onboarding background pollers.
 *
 * The published app runs on an autoscale deployment, which only executes
 * while HTTP requests are in flight — so the in-process setInterval
 * pollers (system watcher, watch-mailbox tracker, Gmail reply monitor)
 * pause when nobody has the app open. Running this script on a schedule
 * (e.g. a Replit Scheduled Deployment or any external cron, every 1-5
 * minutes) wakes the API server and drives one round of every poller.
 *
 * Usage:
 *   HEARTBEAT_URL=https://<your-app>.replit.app node scripts/watcher-heartbeat.mjs
 * Defaults to the current production deployment URL when HEARTBEAT_URL is unset.
 * If the server has WATCHER_TICK_TOKEN set, export the same value here so
 * the request is authenticated (sent as the x-watcher-token header).
 */

const base = process.env.HEARTBEAT_URL ?? "https://hro-agent-nexus.replit.app";
const url = `${base.replace(/\/$/, "")}/api/onboarding/webhooks/watcher-tick`;

const headers = process.env.WATCHER_TICK_TOKEN
  ? { "x-watcher-token": process.env.WATCHER_TICK_TOKEN }
  : undefined;
const res = await fetch(url, { method: "POST", headers });
const body = await res.text();
console.log(`[watcher-heartbeat] ${res.status} ${url} -> ${body}`);
if (!res.ok) process.exit(1);
