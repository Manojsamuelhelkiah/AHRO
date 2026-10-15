# Data sensitivity and privacy enforcement

The product default is **Deferred**, in both development and production and
for every client without an explicit enforcement setting.

Client Setup → **Data sensitivity and privacy** lets a client administrator
with current policy-management permission select **Active** later. Changes
are version-checked and recorded in the protected audit history.

Deferred mode does not require sensitivity classification, class-specific
collection/disclosure policies, their privacy-review receipts, or privacy
attribution of historical opaque narratives before normal workflow progress.
Existing labels, rules and review receipts remain unchanged. Deferral never
creates an approval or claims privacy compliance.

Privacy retention deletion/minimization and execution-context pruning pause.
Existing jobs are retained for recovery. Active resumes cleanup only under
the existing approved-policy and legal-hold safeguards. It does not approve
missing rules; affected work may block until those rules are configured.

The following do **not** defer: authentication, tenant and case scope,
permissions, private-file access, malware quarantine, employee-owned consent
and withdrawal, exact email-source identity/recipient binding, provider
dispatch admission, evidence/decision authenticity, final offboarding closure,
or protected-audit/regulated production startup checks.

Settings belong to the current client in the current application database.
Development and published databases can differ; the shared code default is
Deferred in either environment. Publishing code does not copy client settings
or fabricate policy reviews. An explicitly Active client remains Active.

The test harness explicitly selects an Active default so the established
privacy-boundary suites continue testing enforcement. Tests of Deferred set
that mode explicitly. HRO_PRIVACY_ENFORCEMENT_DEFAULT is an optional non-secret
deployment default (active/deferred); malformed configuration fails explicitly.
