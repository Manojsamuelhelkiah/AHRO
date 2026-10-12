---
name: Application tenant boundaries
description: Durable rules for client organization isolation with Replit-managed Clerk.
---

The user selected shared-database, logically isolated client organizations rather than dedicated tenant databases on 2026-09-12.

**Why:** Extend the established application-owned tenancy instead of introducing a competing tenant model or unrequested infrastructure migration.

The active client/workspace name must remain visually identifiable even when the user has only one membership. A client name entered into an implementation scenario is not proof that a separate client tenant was created or selected.

**Why:** The user expects to enter a newly set-up client with a clear client name reference and asked how different clients are visually distinguished.

**How to apply:** Show the authenticated, page-pinned workspace identity consistently; distinguish any selected implementation-plan client name from actual tenant scope. Display demo status and actual workspace role without implying professional authority.

The product is SaaS, and the user requires one platform-wide administrator for client setup and administration, rather than relying only on separate client owners.

The initial cross-client administration is intended for two operators. The user wants to reuse the Demo Administrator identity as Super Admin during development and defer tying it to a verified personal email until later. Do not insist on two separate administrator identities as a product requirement.

**Why:** The user explicitly requested one administrator with universal rights and said finer restrictions can be introduced later, then clarified that the same account should serve both demo and super-admin purposes while the product is in development.

**How to apply:** Treat platform administration as an explicit cross-client privilege. Email verification may be deferred for the temporary development administrator, but unrestricted public demo tickets must not grant universal access: protect the privileged sign-in and fence old public sessions before elevation. Before real-client rollout, bind it to a verified private identity. Preserve active-client context and attribution of the actual actor; administrative access does not manufacture professional qualifications, source verification or employee consent.

When one shared identity serves both restricted demo and privileged development sessions, platform privilege belongs to the authenticated session/request, not to that identity's permanent memberships or demo registry.

**Why:** Promoting the shared identity itself would silently elevate ordinary sessions using the same account and background work attributed to it. The user chose identity reuse, not public universal access.

**How to apply:** Preserve restricted ordinary sessions and independent specialist/evidence gates. Bind private administration to a fresh active session and the verified current tenant; do not propagate it into background jobs or employee-owned private Vault records. State explicitly when development access does not apply to the published runtime.

Production platform administration must use a separately approved private,
provider-verified identity with enrolled MFA and fresh factor verification.
Approval is a protected operator decision, not a public setup form; do not pick
or approve an administrator from an entered email or assume a demo account is
the intended person. Keep Development and Production approvals separate.

**Why:** The published-app rollout requires verified private administration
without converting public demo eligibility into cross-client authority.

**How to apply:** Obtain the intended account and explicit private approval
before binding it. Treat session revocation/approval withdrawal as loss of
platform privilege while preserving legitimate tenant roles and independent
professional, evidence, privacy, and personally owned Vault boundaries.

**How to apply:** Preserve shared storage with explicit server-enforced organization boundaries; dedicated databases or cross-client learning require a separate decision.

Membership removal must revoke access without allowing a shared join code or later reinstatement to revive old specialist grants.

**Why:** Deleting only a membership would let an account rejoin while its prior authority still exists. Revocation must also serialize with operator grants and in-flight governed dispatch.

**How to apply:** Preserve revocation history, enforce active membership on authority-bearing paths, and require fresh verified specialist grants after any future reinstatement.

Replit-managed Clerk authenticates people but does not provide Clerk Organizations. Client tenancy must therefore be application-owned: users select an organization, and the server accepts that selection only after verifying a persisted membership. Organization scope is cumulative with any narrower owner boundary that predates tenancy: owner-private scenarios and uploads remain owner-private inside their organization. A retained migration workspace is not necessarily disposable even if its identifier looks temporary: interval-created scenarios may rely on tenant-local configuration there, so preserve valid stored selections and provide an explicit membership switcher instead of redirecting automatically. Browser requests must use the workspace pinned to that mounted page during bootstrap; never reread an origin-wide selector at dispatch, because another tab can change shared storage while an old tenant form remains open. Case-less operational and security-audit events still need an explicit organization; tenant feeds must scope these rows directly rather than inner-joining through an optional parent. Rejected public webhooks whose tenant cannot be safely inferred belong to an explicit platform-audit organization, never an inferred client.

**Why:** User-level authentication alone does not isolate cases, estimates, custom configuration, uploads, or external effects. Defaults such as a shared demo tenant hide missing ownership and can silently cross tenant boundaries. A tenant migration once broadened owner-private scenarios and uploads because organization checks replaced, rather than supplemented, owner checks. A later recovery pass treated all migration workspaces as historical and redirected users to demo, separating newer scenarios from their custom intents, flow overrides, and rates. A workspace switcher then exposed a cross-tab dispatch flaw: changing shared storage in one app silently retargeted an unsaved form in another tab to a different tenant. The same migration work also hid null-case outage events by joining through cases and dropped forged-webhook evidence because its audit writer incorrectly required a case.

**How to apply:** Every client-owned row must carry an explicit organization identifier with no runtime default. Scope reads, writes, natural uniqueness, idempotency, caches, background jobs, and child-parent foreign keys by organization. Preserve owner/uploader predicates for records that were already private, and use tenant-aware parent-child constraints for attachments. Keep historical demo data in an explicit demo organization. During staged tenancy migrations, distinguish pre-existing rows from interval-created rows and keep the latter co-located with tenant-local dependencies; never route based only on a workspace-name prefix. Let users switch among every retained membership. Pin the selected membership into each page's request scope before protected content mounts; switching may reload that page into a new scope, while other tabs remain pinned until they reset. Route exports and other raw-fetch side channels through that same scope. Namespace persisted client drafts by authenticated user and pinned organization, and quarantine old unscoped keys rather than adopting them. Test cross-app, two-tab submission and reload with unsaved old-tenant forms. For rows with nullable parent IDs, query by the row's organization. Public rejection handlers must choose an explicit platform audit scope and await persistence before returning.