---
name: Clerk demo login via sign-in tickets
description: Demo accounts with undeliverable emails can't pass Clerk device verification; use backend sign-in tickets.
---

Clerk device verification sends an email code at sign-in (status `needs_second_factor`, strategy `email_code`) even when the password is correct. A demo account with an undeliverable address (e.g. `@example.com`) can therefore never complete a password sign-in.

**Why:** The shared demo reviewer account hit this — password accepted, then stuck on an email code nobody can receive.

**How to apply:** For one-click demo logins, have the backend mint a one-time Clerk sign-in ticket (`clerkClient.signInTokens.createSignInToken`) from an unauthenticated endpoint locked to the demo email only, and the client consumes it with the signals API `signIn.ticket({ ticket })` then `signIn.finalize()`. Note the installed `@clerk/react` uses the signals-based `useSignIn` (`{ signIn, errors, fetchStatus }`) — there is no `isLoaded`/`setActive`; factor methods return `{ error }` and session activation is `signIn.finalize()`. FAPI can be probed from shell via a `/v1/dev_browser` token to see the real sign-in status.
