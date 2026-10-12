# Development Super Admin

The Super Admin uses the same Clerk account identity as the former Demo
Administrator. The private password is read only on the API server from
`DEV_SUPER_ADMIN_PASSWORD`; it is never prefilled or bundled into the browser.

## Sign-in

In the development preview, choose **Super Admin**, enter its private password,
and sign in. Incorrect or missing passwords cannot obtain an admin ticket.
The restricted Demo Reviewer still has its ordinary demo-only sign-in.

The first protected login for a credential epoch revokes existing provider
sessions before issuing a new ticket. Further protected logins can coexist so
the two development testers can use the account concurrently. Signed,
HttpOnly proofs are bound to an active Clerk session and expire after four
hours. Logout clears the proof. Rotating the Secret invalidates old proofs and
causes a fresh provider-session fence on the next protected login.

## Client administration

The header always identifies the selected organization, including accounts
with only one workspace. Super Admin sees the available client organizations,
can select one, and can create a separate client with **New client**.
Switching validates the target, persists the selection and reloads the page
so outstanding forms cannot silently change tenants.

Creating a client organization is distinct from saving a Client Setup
implementation plan inside an existing organization.

The protected human request receives administrative access keys for the
verified active tenant only. The ordinary sessions of the same shared account
remain demo-capped. Agents, other accounts and background jobs do not inherit
this request privilege. Permission ends when the HTTP request finishes.

## Limits

- Available only when the API runs in development with the Secret configured.
  It is intentionally disabled in a production/published runtime.
- Use fictional data during development. One account means both testers'
  audit records identify that same account.
- This does not manufacture specialist qualifications, approve collection
  policies, authenticate documents, override legal holds or bypass readiness
  evidence. Existing protected audit and operational safeguards still apply.
- Employee Vault remains personally owned; this is not universal access to
  other employees' private Vaults.
- A production Super Admin needs a private verified identity and appropriate
  strong-authentication/session controls before real-client rollout.
