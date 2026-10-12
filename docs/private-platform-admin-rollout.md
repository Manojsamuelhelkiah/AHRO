# Private platform administrator rollout

No account is approved automatically and this change does not publish the app.
The shared development password is never accepted in production.

## Approval boundary

An operator with private workspace access must independently confirm the intended
person and their **Clerk user ID and primary email-address ID**. An entered email,
public demo marker, tenant-owner role, or personal Vault account is not approval.
Use a private decision reference; do not put personal contact details, passwords,
tokens, or recovery codes in commands, source control, audit references, or chat.

Development and Production Clerk accounts are separate. Approve each separately
against its actual provider account. Never copy an approval between environments.
Shared demo accounts and placeholder addresses cannot be privately approved.

## Verify in development first

1. In the Development Clerk instance, enable authenticator-app MFA using Replit's
   managed Clerk dashboard. The intended administrator signs in through **Private
   account sign-in · MFA supported**, verifies their primary email, and enrolls
   MFA. Account enrollment is not platform approval.
2. Independently confirm the provider account IDs with that person. With protected
   workspace access, record the private approval decision and run:

   ```sh
   NODE_ENV=development pnpm --filter @workspace/api-server admin:private \
     approve development <confirmed-user-id> <confirmed-primary-email-id> <decision-reference>
   ```

   This command requires the matching test Clerk credential, a verified primary
   email, and enrolled MFA. It removes old eligibility and revokes all active
   sessions before writing a new approval generation in **private** provider
   metadata. It never creates permanent cross-client membership or specialist
   qualifications. Failed revocation leaves eligibility disabled.
3. Sign in again, complete both factors, then select **Verify / renew administrator
   access**. If either factor is older than five minutes, Clerk requests step-up.
   The server checks signed factor-age claims; unavailable claims are denied,
   not replaced with a client timestamp or a ticket.
4. Confirm the workspace shows its actual client name and **Super Admin · Private
   MFA session**. Select a client before operating on its data. Each request still
   checks the selected tenant, current provider approval generation, verified
   primary identity, MFA enrollment, factor ages, and active provider session.
5. Confirm a different session cannot reuse the cookie, restricted public demo
   sessions remain restricted, specialist decisions still need verified authority,
   and employer requests cannot read another person's private Employee Vault.
6. Confirm **End session** revokes the actual provider session. Revoke approval using
   the command below and confirm outstanding administrator requests are rejected.

## Safe production procedure — operator action required

1. Obtain explicit private approval for the intended production identity. Do not
   reuse the development shared account. In the Production Clerk instance enable
   MFA, verify the intended primary email, and enroll an authenticator.
2. Keep the existing production startup tenant/database/audit safety gates enabled.
   Use a strong `SESSION_SECRET` (at least 32 characters) in Replit Production
   Secrets; never print it. HTTPS and same-origin requests are required. Missing
   approval, signing setup, MFA, or provider availability blocks administration.
3. Run development regression checks. Publish **only when the operator decides to**.
   The new code starts with private production administration disabled because
   there is no matching production approval.
4. In a private operator runtime configured with the actual Production Clerk
   credential and production audit database, independently confirm the production
   provider IDs and run:

   ```sh
   NODE_ENV=production pnpm --filter @workspace/api-server admin:private \
     approve production <confirmed-user-id> <confirmed-primary-email-id> <decision-reference>
   ```

   Do not swap production secrets into the running development API. The command
   refuses test credentials labeled as production. Record the decision privately.
5. Perform the development checks above against production, using a disposable,
   explicitly authorized tenant before operating on any real client.

## Expiry and revocation

- Elevation lasts at most 15 minutes, and both provider-verified factors must be
  no older than 15 minutes on every privileged request. Activation/renewal requires
  both within five minutes. Expired/invalid grants reject requests rather than
  silently falling back to a tenant role; the renewal/end controls remain reachable.
- **End session** durably revokes the Clerk session and clears the cookie.
- To remove eligibility and revoke all of that account's active sessions:

  ```sh
  NODE_ENV=<environment> pnpm --filter @workspace/api-server admin:private \
    revoke <environment> <confirmed-user-id> - <decision-reference>
  ```

- Changing or un-verifying the primary identity, disabling MFA, revoking the
  provider session, removing approval, rotating its generation, or rotating
  `SESSION_SECRET` invalidates the grant. Provider outages fail closed.
- Revocation does not depend on the old email ID, MFA enrollment, or demo status:
  the operator can always remove eligibility for the confirmed provider user.
  Operator transitions are serialized per account across processes.
- Approval is not a background-worker privilege. Request-scoped authority ends
  at response completion/expiry and is never inherited as permanent membership.
- Actions retain the real authenticated actor ID and the verified active client.
  Administration does not create professional authority, source evidence,
  employee consent, historical approval, or ownership of a personal Vault.
