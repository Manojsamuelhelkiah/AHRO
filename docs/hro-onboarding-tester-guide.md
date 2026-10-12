# HRO Onboarding Platform
## End-to-End Test Case with Synthetic Data

**Test case ID:** HRO-E2E-ONB-001  
**Purpose:** Verify that a new employee onboarding case triggers the expected automation, candidate communication, portal access, Day-1 logistics, checklist controls, and audit evidence.  
**Estimated duration:** 20–30 minutes, excluding email delivery time.  
**Data classification:** Synthetic test data only.

---

## 1. What this test proves

The test passes when the platform:

1. Creates a real onboarding case from the supplied synthetic data.
2. Applies the correct employee profile, joining date, priority, and communication channel.
3. Automatically creates and sends a secure candidate portal link when candidate email is authorized.
4. Displays the saved Day-1 logistics in the case and candidate portal.
5. Tracks documents, communications, activity, and checklist evidence.
6. Enforces mandatory Day-1 checklist rules.
7. Allows a blocked checklist item to be completed and the onboarding workflow to continue.
8. Does not expose the secret candidate portal URL in the case communication history.

---

## 2. Preconditions

Before starting, confirm:

- You have an authorized HR, administrator, or owner account.
- The test environment is running and you can open the control tower.
- You are allowed to create a **real test case**, rather than a seeded scenario case.
- You have access to a monitored QA email inbox.
- The monitored inbox must be substituted for the synthetic email below if you need to test actual email receipt.
- Do not use a real employee’s name, email address, phone number, documents, or bank information.
- Do not select WhatsApp for this test unless a dedicated test number has been approved.

> **Email safety:** `priya.nair.qa@example.com` is documentation-only and will not receive mail. Replace it with an approved QA inbox, ideally using a unique plus-address such as `qa.onboarding+priya-20260909@your-test-domain.example`.

---

## 3. Synthetic employee data

Use the following values when creating the case.

| Field | Synthetic value |
|---|---|
| Worker Name | Priya Nair |
| Email | Replace with monitored QA inbox |
| Documentation-only email | priya.nair.qa@example.com |
| Phone | Leave blank |
| Contact Channel | Email only |
| Hire Type | External FTE |
| Worker Category | Employee |
| Worker Band | P3 |
| Role | Senior Data Analyst |
| Department | People Analytics |
| Geography | India |
| Legal Entity | Example HQ India Pvt Ltd |
| Joining Date | 2026-09-21 |
| Manager | Arjun Mehta |
| Recruiter | Neha Kapoor |
| Urgency | High |
| Notes | Synthetic QA case. Validate automated portal delivery, Day-1 logistics, mandatory checklist gates, candidate document upload, and audit history. No real personal data. |

### Expected Day-1 logistics

The case should receive the organization’s current Day-1 logistics snapshot. In a default synthetic workspace, expect Example HQ / Demo People Team information. Record the actual values shown for:

- Date and time
- Format: onsite, remote, or hybrid
- Venue or meeting location
- Reporting contact
- Joining instructions
- Virtual meeting link, if configured

The exact configured values may differ from this guide. The important result is that the section is populated and remains specific to this case.

---

## 4. Step-by-step test procedure

### Step 1 — Sign in and open Cases

1. Sign in to the HRO control tower.
2. Select **Cases** from the main navigation.
3. Confirm the Cases page loads.
4. Select **New Case**.

**Expected result**

- The new-case form opens.
- The form includes worker details, contact channel, hire details, joining date, manager, recruiter, urgency, and notes.

**Evidence to capture**

- Screenshot of the empty new-case form.

---

### Step 2 — Enter the synthetic profile

1. Enter every value from **Synthetic employee data**.
2. For **Email**, use the approved monitored QA inbox.
3. Select **Email only** as the contact channel.
4. Leave **Phone** blank.
5. Review the values before submission.

**Expected result**

- Required fields accept the data.
- No WhatsApp phone validation is required because **Email only** is selected.
- The joining date and high urgency are visible before submission.

**Evidence to capture**

- Screenshot of the completed form with the email address partially masked.

---

### Step 3 — Create the onboarding case

1. Select **Create Case** once.
2. Wait for creation and routing to finish.
3. Do not double-click or submit the form a second time.

**Expected result**

- One new case is created for **Priya Nair**.
- The case appears in the Cases list or opens directly.
- The case shows the correct role, department, joining date, and priority.
- The onboarding workflow begins or displays its next required action.

**Evidence to capture**

- Case ID.
- Creation time.
- Screenshot of the case header.

---

### Step 4 — Verify the case overview and Day-1 logistics

1. Open the newly created case.
2. Review the health summary.
3. Locate **Day-1 Readiness**.
4. Locate **Logistics & Portal Access**.
5. Record the logistics values shown.

**Expected result**

- Health information includes case health, progress, SLA, and next milestone.
- Day-1 readiness is associated with the joining date.
- Logistics are populated; the section is not empty.
- The portal control indicates automatic issuance is normal for an Email-authorized case.

**Failure conditions**

- Logistics are blank.
- The joining date is missing or incorrect.
- The case belongs to the wrong worker or tenant.

---

### Step 5 — Verify automatic candidate portal delivery

1. Open the monitored QA inbox.
2. Wait for the onboarding email.
3. Check spam or quarantine if necessary.
4. Record the received time and subject.
5. Do **not** select **Issue Link Manually** unless the automatic action has clearly failed and the tester is documenting a recovery test.

**Expected result**

- Exactly one relevant portal communication is delivered for this case.
- The message identifies the synthetic candidate or onboarding context.
- It includes a secure candidate portal link.
- It includes or reflects the case’s Day-1 logistics.
- Refreshing the case does not send another copy.

**Security check**

1. In the control tower, open the case’s **Communications** or **Activity** history.
2. Inspect the stored portal communication.

**Expected security result**

- The history contains a redacted record of the message.
- The full secret portal URL or raw portal token is not displayed in stored history.

**Failure conditions**

- No email arrives after the agreed delivery window.
- Multiple portal emails are sent for one creation event.
- The raw secure URL is visible in the case timeline or communication history.

---

### Step 6 — Open the candidate portal

1. Copy the portal link from the QA inbox into a private/incognito browser window.
2. Open the link.
3. If the first request redirects, allow it to complete.

**Expected result**

- The secure link opens the candidate portal.
- The portal displays **Priya Nair**, the role, and department.
- Day-1 Logistics show date/time, format, venue, reporting contact, and instructions.
- Required documents are listed with their current statuses.
- The browser establishes a secure candidate session without exposing HR control-tower access.

**Failure conditions**

- The candidate can see another employee’s data.
- The candidate can access HR administration pages.
- The valid new link is rejected as invalid or expired.
- Day-1 logistics are absent.

---

### Step 7 — Test a synthetic document upload

Prepare a harmless test file:

- File name: `priya-nair-synthetic-id-proof.pdf`
- File contents: A single page stating `SYNTHETIC QA DOCUMENT — NOT A REAL ID`
- Maximum size: less than 1 MB
- Do not include signatures, identification numbers, addresses, or photographs of real people.

Then:

1. In the candidate portal, select one requested document.
2. Upload the synthetic PDF.
3. Wait for confirmation.
4. Return to the HR case.
5. Open **Documents** and refresh if needed.

**Expected result**

- PDF upload is accepted.
- The document status changes to received/submitted or the equivalent current state.
- HR can see that it was submitted through the candidate portal.
- The upload is associated only with the Priya Nair test case.

**Failure conditions**

- The upload appears under another case.
- The portal accepts a file over the displayed limit.
- The status remains missing after a successful upload and refresh.

---

### Step 8 — Verify checklist and mandatory rules

1. In the HR case, open **Overview** or **Tasks** and locate **Day-1 Readiness**.
2. Identify each mandatory and optional checklist item.
3. Record the initial state of every mandatory item.
4. If an incomplete mandatory item is present, confirm the case shows that onboarding is paused, blocked, or awaiting completion.
5. Add a synthetic note such as: `QA verified prerequisite in test environment.`
6. Select **Complete** for the chosen mandatory test item.
7. Refresh the case.

**Expected result**

- Mandatory and optional items are visually distinguishable.
- An unmet mandatory gate prevents inappropriate progression.
- Completing an item records the tester’s action and note.
- When all mandatory requirements are satisfied, the workflow resumes or advances to its next valid state.
- Completion does not resend the welcome or portal email.

**Evidence to capture**

- Checklist state before completion.
- Checklist state after completion.
- Resulting case status or next milestone.

---

### Step 9 — Test reopening a mandatory item

Only perform this in an approved test environment.

1. Select **Reopen** on the mandatory item completed in Step 8.
2. Add the note: `QA reopening item to validate Day-1 gate enforcement.`
3. Refresh the case.

**Expected result**

- The item returns to incomplete.
- The case returns to an appropriate preboarding, blocked, or re-review state.
- The reason is visible to HR.
- Previously completed remote actions are not blindly repeated.
- No duplicate candidate portal email is sent.

Then complete the item again so the test case is left in a consistent state.

---

### Step 10 — Review traceability

Review these case tabs:

- **Overview**
- **Tasks**
- **Documents**
- **Activity**
- **Communications**
- **Audit**

**Expected result**

The tester can find evidence for:

- Case creation
- Workflow or specialist-agent activity
- Portal communication, stored in redacted form
- Candidate document submission
- Checklist completion and reopening
- Tester notes and timestamps
- Current owner, status, progress, and next action

No tab should reveal a raw portal token or data belonging to another organization.

---

## 5. Pass/fail checklist

Mark each item.

| Verification | Pass | Fail | Notes / evidence |
|---|:---:|:---:|---|
| One onboarding case was created | ☐ | ☐ | |
| Worker details match the synthetic profile | ☐ | ☐ | |
| Day-1 logistics are populated | ☐ | ☐ | |
| One automatic portal email was delivered | ☐ | ☐ | |
| No duplicate portal email was generated | ☐ | ☐ | |
| Candidate portal shows the correct worker | ☐ | ☐ | |
| Candidate portal shows Day-1 logistics | ☐ | ☐ | |
| Synthetic document upload succeeds | ☐ | ☐ | |
| Document appears in the correct HR case | ☐ | ☐ | |
| Mandatory checklist gate blocks when incomplete | ☐ | ☐ | |
| Completing mandatory items allows valid progression | ☐ | ☐ | |
| Reopening a mandatory item re-enforces the gate | ☐ | ☐ | |
| Checklist changes do not resend portal email | ☐ | ☐ | |
| Communications history is redacted | ☐ | ☐ | |
| Activity and audit evidence are present | ☐ | ☐ | |
| No cross-case or cross-tenant data is visible | ☐ | ☐ | |

---

## 6. Defect reporting template

Use one report per defect.

**Title:**  
`[Onboarding QA] <short description>`

**Environment:**  
Development / staging / other:

**Case ID:**  

**Test account role:**  

**Step that failed:**  

**Expected result:**  

**Actual result:**  

**Time observed and timezone:**  

**Screenshots or recording:**  

**Relevant email subject and received time:**  
Do not paste the secure portal URL.

**Repeatable:**  
Always / intermittent / once

**Security or privacy impact:**  
None / suspected / confirmed

---

## 7. Cleanup

After evidence has been captured:

1. Revoke the candidate portal link using the HR recovery controls, if required by the test policy.
2. Do not forward or paste the portal URL into a defect report.
3. Remove the synthetic uploaded document if the environment supports approved deletion.
4. Mark the case clearly as synthetic QA data.
5. Archive or close the case according to the environment’s test-data retention procedure.

---

## 8. Optional negative tests

Run these as separate cases so the primary test remains easy to diagnose.

### A. WhatsApp selected without a phone

- Select **WhatsApp only**.
- Leave Phone blank.
- Attempt to create the case.

**Expected:** The form warns that a phone number is required and prevents submission.

### B. Expired or revoked candidate link

- Revoke a test portal link.
- Open it in a new private browser session.

**Expected:** Access is denied with an invalid-or-expired message.

### C. Duplicate-processing protection

- Refresh the case repeatedly after successful portal delivery.
- Revisit the case from the Cases list.

**Expected:** No second automatic portal email is sent.

### D. Optional checklist item

- Reopen an optional item while mandatory items remain complete.

**Expected:** The optional item is visibly incomplete but does not incorrectly trigger a mandatory gate.

---

## 9. Configuration scenario — change the Day-1 checklist and flow

**Scenario ID:** HRO-CONFIG-DAY1-001  
**Purpose:** Prove that an authorized administrator can configure checklist items and enforcement stages, that new cases receive the correct snapshot, and that mandatory items change workflow progression.

### Important behavior

- Checklist configuration requires an organization **owner or administrator**.
- The current timeline choices are workflow gates, not calendar offsets:
  - **Before Workstreams**
  - **Before Comms**
  - **Before Day-1**
- Only enabled, mandatory items block the applicable gate.
- Optional items do not block progression.
- Configuration is snapshotted when a case is created. Existing cases do not change automatically.
- Updating an active case requires the deliberate **Manage Case Checklist** flow and may force a fresh review.

### Configuration test data

Add these three synthetic items to the organization default checklist:

| Order | Item label | Stable ID | Status | Requirement | Enforcement stage | Intended effect |
|---:|---|---|---|---|---|---|
| Next available | Confirm employee profile | qa-confirm-profile | Enabled | Mandatory | Before Workstreams | Workstreams must not start until completed |
| Next available | Confirm welcome pack | qa-confirm-welcome-pack | Enabled | Mandatory | Before Comms | Candidate communications must wait until completed |
| Next available | Schedule buddy coffee | qa-schedule-buddy-coffee | Enabled | Optional | Before Day-1 | Visible for tracking but must not block |

> Use the next contiguous order numbers shown by the screen. Checklist order must begin at zero and remain contiguous.

### Step A — open checklist settings

1. Sign in as an organization owner or administrator.
2. Select **Settings**.
3. Locate the organization’s Day-1 checklist settings.
4. Record the current checklist version and take a screenshot.

**Expected result**

- Checklist administration controls are visible.
- Existing items show label, stable ID, enabled status, mandatory/optional requirement, enforcement stage, and order.

### Step B — add and save the synthetic items

1. Add the three items from **Configuration test data**.
2. Ensure every stable ID is lowercase and unique.
3. Use contiguous order numbers.
4. Save the checklist.

**Expected result**

- The save succeeds.
- A message similar to **Checklist updated to version N** appears.
- The new version is greater than the version recorded in Step A.

**Validation checks**

- A duplicate stable ID must be rejected.
- Duplicate or non-contiguous order values must be rejected.
- An empty label must be rejected.
- An enabled mandatory workstream-owned item must not be configured to block before workstreams.

Correct any deliberately introduced invalid value before continuing.

### Step C — create a case that receives the new configuration

Create a second synthetic case:

| Field | Value |
|---|---|
| Worker Name | Daniel Okafor |
| Email | Approved monitored QA inbox |
| Contact Channel | Email only |
| Hire Type | External FTE |
| Worker Category | Employee |
| Worker Band | P2 |
| Role | Service Delivery Analyst |
| Department | Operations |
| Geography | India |
| Legal Entity | Example HQ India Pvt Ltd |
| Joining Date | 2026-09-28 |
| Manager | Maya Iyer |
| Recruiter | Neha Kapoor |
| Urgency | Normal |
| Notes | Synthetic checklist configuration test. No real personal data. |

**Expected result**

- The new Daniel Okafor case contains all three synthetic checklist items.
- The earlier Priya Nair case remains unchanged because it retained its original checklist snapshot.

### Step D — verify the Before Workstreams gate

1. Open the Daniel Okafor case.
2. Leave **Confirm employee profile** incomplete.
3. Observe the case status, activity, next milestone, and specialist workstreams.

**Expected result**

- The case shows that onboarding is paused or blocked by the mandatory item.
- Workstreams do not progress past the configured gate.
- The optional buddy-coffee item is not reported as the blocking reason.

Then:

1. Add the note `QA completed employee profile prerequisite.`
2. Select **Complete** for **Confirm employee profile**.
3. Refresh the case.

**Expected result**

- The workstream gate clears.
- The workflow advances to its next valid stage.
- The completion and note are recorded in Activity or Audit.

### Step E — verify the Before Comms gate

1. Leave **Confirm welcome pack** incomplete.
2. Monitor the QA inbox and the case Communications tab.

**Expected result**

- Candidate communication waits at the Before Comms gate.
- The case identifies the mandatory welcome-pack item as incomplete.

Then:

1. Add the note `QA approved the synthetic welcome pack.`
2. Complete **Confirm welcome pack**.
3. Refresh the case and monitor the QA inbox.

**Expected result**

- Communication processing resumes.
- The authorized onboarding/portal email is delivered exactly once.
- The completion action is audited.

### Step F — verify that an optional item does not block

1. Leave **Schedule buddy coffee** incomplete.
2. Complete all other mandatory prerequisites.
3. Observe the case’s progression toward Day-1 review.

**Expected result**

- The optional item remains visible and incomplete.
- It does not pause or block the case.
- The case can reach the Day-1 review when all mandatory items are satisfied.

### Step G — verify existing-case snapshot protection

1. Return to the earlier Priya Nair case.
2. Review its checklist.

**Expected result**

- The three newly configured items have not appeared automatically.
- Existing completion states and case-specific configuration remain unchanged.

If authorized to test active-case replacement:

1. Select **Manage Case Checklist**.
2. Review the proposed recalculation or replacement.
3. Enter a reason explaining that this is a synthetic QA test.
4. Apply the change only in an approved non-production environment.

**Expected result**

- The action is deliberate rather than automatic.
- Matching item statuses are preserved where possible.
- The replacement and reason are audited.
- The case may return to re-review when new mandatory blockers are introduced.

### Step H — test a targeted checklist profile

1. In **Settings**, locate **Targeted Checklist Profiles**.
2. Select **Create Profile**.
3. Enter:

| Field | Value |
|---|---|
| Profile Name | QA P2 Operations Profile |
| Priority | 50 |
| Band Match | P2 |
| Role Match | Service Delivery Analyst |
| Employment Type Match | External FTE, if offered by the current selector |
| Location Match | India |
| Profile Enabled | Yes |

4. Add an item override:

| Field | Value |
|---|---|
| Target Item ID | qa-operations-induction |
| Override Label | Complete Operations induction |
| Status | Included |
| Requirement | Mandatory |
| Enforcement Stage | Before Day-1 |
| Order | Next valid order |

5. Save the profile.
6. Create a third case matching P2, Service Delivery Analyst, External FTE, and India.
7. Create a fourth case with a non-matching role or band.

**Expected result**

- The matching case receives the targeted Operations induction item.
- The non-matching case receives the default checklist without that targeted item.
- The mandatory targeted item blocks the matching case before Day-1 review until completed.
- An equal-priority overlapping enabled profile is rejected rather than applied ambiguously.

### Configuration scenario pass/fail checklist

| Verification | Pass | Fail | Notes / evidence |
|---|:---:|:---:|---|
| Owner/admin can edit checklist configuration | ☐ | ☐ | |
| Invalid IDs or ordering are rejected | ☐ | ☐ | |
| Saving creates a new checklist version | ☐ | ☐ | |
| New case receives the new checklist snapshot | ☐ | ☐ | |
| Existing case remains unchanged automatically | ☐ | ☐ | |
| Before Workstreams mandatory item blocks workstreams | ☐ | ☐ | |
| Before Comms mandatory item delays communication | ☐ | ☐ | |
| Completing a blocker resumes the correct flow | ☐ | ☐ | |
| Optional item does not block progression | ☐ | ☐ | |
| Configuration and status changes are audited | ☐ | ☐ | |
| Matching targeted profile is applied | ☐ | ☐ | |
| Non-matching case retains the default checklist | ☐ | ☐ | |
| Overlapping equal-priority profile is rejected | ☐ | ☐ | |

### Restore the test environment

After testing:

1. Disable or remove the synthetic targeted profile.
2. Remove the three `qa-` default checklist items, or restore the approved baseline configuration.
3. Save and record the resulting checklist version.
4. Confirm no real onboarding cases were created while the synthetic configuration was active.
5. Retain screenshots and case IDs in the QA evidence record.

---

**End of test guide**

---

## Product Learning Guide and UAT Test Center (version 2026.09.14)

The in-app **Learning Guide** (`/learning-guide`) is the current role-based
reference for the whole Control Tower. It links operations, cases and candidate
portal; work items and handoffs; workforce transfers; AI and cited policy;
analytics and recommendations; guardrails; policy review/library/reminders;
systems; client setup; audit/archive; membership and verified specialist
authority; checklist profiles; early-tenure, readiness/SLA and privacy;
fictional offline samples; and the separate Test Center application.

The **UAT Test Center** (`/uat/`) creates a versioned, tenant-scoped
run with a fixture seed, baseline revision, scoped clock, step/evidence history,
normalized provider-exchange history and redacted export. It supports
UAT-STD-01 (standard), UAT-FLT-01 (frontline/bulk), UAT-XFR-01 (transfer),
UAT-DOC-01 (document boundary), UAT-EMAIL-01 (communications), UAT-SEC-01
(isolation/recovery), and UAT-OPS-01 (provider exchanges).

### Evidence interpretation

- **Passed** means only that the recorded step met its stated criterion in its
  stated mode. **Failed**, **Blocked**, **Not run**, and **Not applicable**
  retain their reason in the export.
- Simulated exchanges and the scoped clock never call vendors, change
  production time, worker leases, credentials, real-case deadlines, readiness
  or historical KPIs.
- Fixture packs contain only clearly labeled fictional harmless content.
  Local file/type/integrity results do not prove malware safety, identity,
  issuer authenticity, expiry or employment eligibility.
- Real email is not authorized or sent by a Test Center run. Historical
  provider results remain evidence only; delayed replies cannot advance a
  retired controller case. An uncertain attempt is never automatically resent.
- Provider sandbox/vendor certification, legal transfer basis, human
  specialist decisions, retention/hold outcomes and cross-tenant checks are
  intentionally marked blocked or manual until independently observed.

See `onboarding-product-feature-inventory.json` for the product-feature
denominator and `onboarding-uat-traceability-matrix.csv` for BRD and
cross-cutting coverage, evidence and open gaps.