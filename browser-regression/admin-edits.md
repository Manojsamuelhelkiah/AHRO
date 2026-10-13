# Verified administrator edit regression

Run `pnpm test:browser-admin-edits` from the workspace root.

This dedicated Playwright configuration covers the actual profile-context
correction dialog, an optional manually editable checklist item, and a document
evidence correction note. Each save uses the real API and is confirmed after a
browser reload, in both development Super Admin and private-admin proof modes.
It checks persisted values, authenticated audit attribution, unchanged
historical records, and absence of communication/provider-effect records.

The existing browser server creates and migrates a disposable database schema
before importing application modules, verifies schema-contained foreign keys,
uses owned fictional identities and loopback-only authentication, blocks
external providers, and drops its schema at shutdown. No live client/Demo
records are used. Evidence has no source bytes and no authenticity assertion.
Administrator password, private approval, session and MFA proofs are simulated
only in this isolated process; this is not a real-provider MFA integration test.

Local HTTPS uses OpenSSL and a one-day self-signed certificate in the ignored
`generated-artifacts/` directory. Production same-origin/HTTPS checks stay
unchanged. Chromium uses the workspace-native executable where available.

Employee Vault consumption is disabled only for this edit fixture. Its separate
consent/reuse journey is outside this regression and currently has a hanging
read in the enabled isolated fixture. Existing Cases/intake failures are not
restored or included by this dedicated configuration.
