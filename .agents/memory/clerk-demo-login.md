---
name: Clerk demo login via sign-in tickets
description: Demo accounts with undeliverable emails can't pass Clerk device verification; use backend sign-in tickets.
---

Clerk device verification sends an email code at sign-in (status `needs_second_factor`, strategy `email_code`) even when the password is correct. A demo account with an undeliverable address (e.g. `@example.com`) can therefore never complete a password sign-in.

**Why:** The shared demo reviewer account hit this — password accepted, then stuck on an email code nobody can receive.

Verify the authenticated subject before treating unexpected tenant permissions as an authorization regression.

**Why:** Synthetic sign-in helpers may create a different identity, while tenant ownership remains bound to the original subject.

**How to apply:** Compare the current authenticated subject with the fixture's owner user ID before diagnosing tenant authorization. Resume the exact identity or create a fresh owned fixture; never broaden a demo-login endpoint to accept arbitrary accounts.

**How to apply:** For one-click demo logins, have the backend mint a one-time Clerk sign-in ticket (`clerkClient.signInTokens.createSignInToken`) from an unauthenticated endpoint locked to the demo email only, and the client consumes it with the signals API `signIn.ticket({ ticket })` then `signIn.finalize()`. Note the installed `@clerk/react` uses the signals-based `useSignIn` (`{ signIn, errors, fetchStatus }`) — there is no `isLoaded`/`setActive`; factor methods return `{ error }` and session activation is `signIn.finalize()`. FAPI can be probed from shell via a `/v1/dev_browser` token to see the real sign-in status.

For isolated browser fixtures, use Clerk's supported reserved development test-email convention, not an arbitrary undeliverable domain.

**Why:** Managed Clerk rejected an `.invalid` synthetic address with HTTP 422; a reserved `+clerk_test@example.com` development identity succeeded. The installed SDK also did not support a commonly suggested email-verification-skip option.

**How to apply:** Check the installed SDK types and documented development test identity options. Use a separate, disposable non-demo actor for private tenant tests, short-lived tickets consumed without logging, and exact owned-fixture cleanup. Never weaken a shared demo sign-in or tenant fence to make a private test pass.

The fixed development verification code applies to reserved test identities, not arbitrary real email addresses. Real operator sign-up must retain normal ownership verification.

**Why:** Broad documentation summaries can omit the reserved-address qualifier. A test alias or developer shortcut cannot establish ownership of a real operator's mailbox.

**How to apply:** Verify the current [Clerk test-email rules](https://clerk.com/docs/guides/development/testing/test-emails-and-phones) before suggesting test codes. For real-email delivery failures, inspect the actual form error and provider delivery restrictions instead of bypassing verification.
