# Template-driven HRO batch creation

Open **Cases → Batch Intake → Template upload** in the Onboarding Agent Control Tower.

1. Select the case family and request template.
2. Download Excel (`.xlsx`) or CSV. Keep its column names, template ID and version unchanged.
3. Fill one request per row, with a stable, unique source `request_id`. Use text employee IDs and `YYYY-MM-DD` dates. Copy template ID/version to every populated row.
4. Upload the completed file and validate. Correct all errors before creating cases; an error report can be downloaded.
5. Review the preview, name the batch and explicitly confirm creation.
6. Open the resulting cases. Authorized import history remains available after reload.

## Coverage

Fourteen versioned templates cover twelve families:

- Onboarding: external employee, contractor, rehire.
- Employee Changes: role/department change.
- Payroll: bank-detail change request.
- Benefits: life-event enrolment.
- Leave: leave request.
- Compliance: work-authorization renewal.
- Offboarding: separation request.
- HR Helpdesk: employment-letter request.
- IT Access: application-access request.
- Learning: course/certification assignment.
- Mobility: cross-border transfer request.
- Documents: policy acknowledgement.

These are input schemas, **not approved policy/checklist templates**. Each case stores its original submitted request and template provenance privately. For onboarding, the existing resolved policy/checklist and offer-acceptance gates remain applicable.

## Review and execution boundaries

All imports create held cases. Non-onboarding requests are held for specialist review and do not run the onboarding engine. Their employee references are explicitly supplied, not verified. Intake does not prove employment, document authenticity, eligibility, approval, execution or completion.

Importing a spreadsheet does not change payroll, grant application access, enrol benefits, approve leave, complete offboarding, initiate a transfer or contact anyone. An independently approved downstream workflow and applicable authority/evidence are required for such work. Existing onboarding mutation endpoints reject imported service requests.

## Access and privacy

- Actual organization owner/admin membership plus explicit case-flow/profile/notes edit grants are required. A demo persona label is not an authorization.
- Current approved collection/lifecycle policies must cover the supplied work jurisdiction. These are checked during valid preview and again at commit, including reconciled imports.
- Submitted narratives require current profile, notes and sensitive-record read authority when disclosed. They are not leaked through the policy snapshot's separate projection.
- Raw workbook/CSV bytes are parsed in bounded memory and not retained. Normalized case fields and immutable reconciliation receipts persist under the existing lifecycle/hold rules.
- Use secure references, not bank-account numbers, document bodies, diagnoses or identity-document numbers. Unexpected columns are rejected.
- Preview/results are cleared on identity/organization/type changes and are not stored in browser local storage.

## Limits and retries

Up to **500 request rows** and **2 MB** per file. Only CSV and ordinary XLSX workbooks are accepted; macros, external links, formulas, numeric identifiers, invalid dates, unexpected columns and unsafe archive sizes are rejected. Empty downloaded templates contain no sample people ready for import; examples appear only in Excel instructions.

The same request ID within the same template and organization identifies the same request, even in a differently named upload. An exact retry reconciles to the existing case; changed facts under an existing request ID are rejected rather than overwriting that case. Repeated requests for the same employee need separate request IDs.

Manual multi-person onboarding intake remains available in **Manual entry**.

## Regression harness

The API test harness includes all-family schema coverage, all fourteen CSV/XLSX template round-trips, no implicit example-case creation, preserved text employee IDs, formula/header/version rejection, row limits, duplicate IDs, calendar validation, stable source fingerprints and private-input exclusion from policy projections.
