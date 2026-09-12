# Client tenancy

## Isolation model

This application uses a shared PostgreSQL database with application-owned client organizations. It does not provision a database per client. Organization scope is enforced by server authorization, scoped queries and tenant-aware database relationships; this is not a claim of database-administrator isolation or universal row-level security.

Clerk authenticates the person. Active application membership determines which client organization that person may access. An organization is a client boundary; its departments, legal entities, sites and job profiles are context within that boundary, not alternate authorization scopes.

## Tenant administration

Use the existing client setup flow to create or join an organization. Owners administer membership in Settings. Changing an application role does not grant professional approval authority such as Legal, Occupational Health or Payroll.

Removing membership preserves its revocation record rather than erasing history. The removed account must not recover access by reusing an old shared join code, and prior specialist authority must not revive. Owners cannot remove or demote themselves through ordinary member administration. Ownership transfer and tenant deletion are not part of this interface.

## Requests and switching

Every protected request resolves an authenticated, active membership on the server. A client-supplied organization ID is a selection, never proof of access. Ambiguous membership requires explicit selection; forbidden selections fail closed.

The browser pins its request scope for the lifetime of the mounted page. Switching validates current target membership before saving the selection and reloading. Changing shared browser storage must not retarget another tab's pending request or unsaved form.

## Data and execution boundaries

- Client-owned records, settings, process policies, caches and idempotency keys retain organization scope.
- Parent-child relationships must prevent references across organizations. Existing uploader-private restrictions remain narrower than organization membership.
- Background jobs and provider callbacks must derive a trusted tenant and preserve it through claim, execution and recovery.
- Shared mailboxes require case-bound attribution; an email address alone does not identify a client or specialist authority.
- Files, AI context and exports must use authorized tenant-scoped inputs, including any narrower record permissions.
- Learned workforce recommendations do not pool client data without separately approved governance.
- Audit evidence has its own retention and independent-protection controls. Membership removal is not permission to erase historical accountability.

## Operational limits

Shared infrastructure is not dedicated-client infrastructure. External credentials, provider capabilities, independent audit archives and sensitive-record permissions have their own configuration and approval requirements. Do not infer readiness for regulated live use merely from tenant membership or a connected-provider label.

Future tenant-owned features must include cross-tenant denial tests and register applicable schema safeguards. Verification of an individual route or worker does not certify every integration or AI data path.