# Operator-approved first Demo administrator

This flow repairs the specific case where **Demo Organization has members but no Owner or Admin**. Demo presentations and demo overrides are available to Demo members under the current presentation policy; administrator privileges remain separate. The setup panel is available in Demo Center even when a member can already run presentations. Setup does not bypass sign-in, authorize other organizations, or recover an already-used bootstrap grant.

## Trust and authorization

- Clerk authenticates the requesting account using normal sign-in.
- Existing membership only permits creating a request; it does not grant administrator authority.
- A trusted project operator who controls the deployment configuration explicitly approves the account-bound request. The operator must verify the requester through a private, trusted channel before approving. Do not approve a request merely because it has a familiar email address or company domain.
- The requester must then explicitly confirm the membership change in the application.
- The application records the grantee (target account), request, timestamps, approval fingerprint, previous/new role, and approval source `deployment-operator`. That source identifies the trust channel, **not a verified individual operator identity**. Deployment configuration access must be restricted to trusted operators.
- The public shared reviewer account cannot use setup, even if its request were approved. Use an individual account with normal authentication.

## Published app procedure

1. Publish the setup feature and its reviewed schema migration using the project's normal guarded publishing process. No membership is changed by publication or migration.
2. The intended administrator signs in to the published app using their own account (not the shared reviewer login), selects **Demo Organization**, and opens **Demo Controller**. Under **First Demo administrator setup**, select **Create private setup request**.
3. The requester privately supplies the approval value to the project operator. It is an opaque account-bound request value, not a password or Clerk user ID. Do not put it in Agent chat, a URL, public messages, logs, or source control.
4. The operator verifies the intended account and request, opens the project's **Publishing → Adjust settings → Deployment secrets**, and sets the server-only secret `DEMO_CONTROLLER_SETUP_APPROVAL` to that exact approval value. Publish to activate the configuration. Do not use a `VITE_` variable or development-only secret for production approval.
5. Within 24 hours of request creation, the same account returns to Demo Controller and selects **Check approval**. After approval is detected, read and select the authorization checkbox, then select **Confirm and enable Demo access**.
6. The server atomically grants **Admin in Demo Organization only** and records the one-time grant. The page reloads to refresh organization permissions. Demo presentation access remains governed by the existing member policy; administrative permissions now reflect the approved grant.
7. Remove the approval secret from the deployment settings and republish. Even before removal, replay cannot grant additional access.

For development, use a development request and development server secret, then restart the API. Never copy an approval between environments. Neither agents nor operators should run production SQL to carry out this flow.

## Failures and limits

- **No approval / wrong value:** nothing changes. Check the environment, exact value, and whether the updated deployment is running.
- **Request expired:** create a new request; the operator must approve the new value. The previous value cannot authorize it.
- **Different signed-in account:** approval cannot transfer to that account, even if it knows the request ID or approval value.
- **Owner/Admin already exists:** setup is unavailable. Use the existing authorized account or contact the project operator.
- **Setup already completed:** bootstrap stays closed, even if that administrator is later removed. Ordinary account recovery or a separately reviewed recovery process is required.
- **Another tenant selected:** select Demo Organization. Roles in another organization do not authorize Demo operations.
- **Response interrupted:** check access again. Completion commits the audit and membership together; retrying a consumed request cannot grant twice.

The feature does not set deployment secrets or promote any account automatically. It deliberately leaves production approval and confirmation to user-authorized actions.