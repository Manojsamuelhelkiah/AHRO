# Importing HR policy documents

Verified policy maintainers and authenticated, tenant-bound private Super Admins can import PDF, DOCX and legacy DOC files from **HR Policy Library → New Policy**, or replace the text in an editable policy version.

1. Select a file. The server bounds actual bytes to 10 MiB and validates extension, media type and file signature. A maintainer may import at most 20 files in 24 hours; the server processes at most four imports at once.
2. Source bytes are written to private App Storage under a tenant-specific namespace. There is no public download, presigned upload or object-path field in the response.
3. The existing explicitly configured private ClamAV scanner must return `clean` before extraction. Missing, timed-out, infected or uncertain scans leave the source quarantined. Parser failure also quarantines the source, even when its scan was clean.
4. Extraction runs locally in an isolated process, with a limited heap, timeout, output cap and no inherited application credentials. PDF extraction is limited to 200 pages; DOCX container expansion is bounded before parsing. Active PDF content, Word macros/embedded objects and external DOCX relationships are unsupported. Legacy DOC files are parsed for body text, never rendered or executed.
5. Preview the filename, upload time, checksum, scan outcome, extraction method and limitations. Compare against your organization's authoritative original, correct the plain text, supply applicability/audience/effective dates, then save a governed **draft**.
6. Independent policy review and publication are unchanged. An uploaded file, a clean malware scan, or successful extraction **does not verify authenticity or approve guidance**. Drafts never become Policy Assistant sources automatically.

## Limitations and operator setup

There is no OCR. Scanned/image-only, encrypted, empty, excessively large or unsupported documents cannot be imported. Text extraction can lose tables, headers, footnotes, formatting and images. The saved text must be non-empty and no longer than 40,000 characters.

Use the existing private scanner configuration and validation process documented for candidate-document malware checking. Never send policy bytes to public antivirus or external extraction services as a workaround. If the private scanner is unavailable, the UI explicitly says so and the import remains unusable.

An import can be attached only by its original authorized uploader, within its original tenant, within 24 hours, and only once. Attachment and policy insertion share a transaction; concurrent attempts cannot attach the same import twice. A failed draft validation does not consume the import. Immutable policy successors preserve provenance unless a fresh source is uploaded.

The UI can discard an unattached ready/quarantined source. The service fences discard against attachment and refuses deletion of attached or processing sources. Canceling a dialog does not delete source bytes: abandoned and interrupted imports remain private and require a separately governed retention/cleanup process. Attached sources are retained with version provenance.

## Regression checks

- `TEST_FILE=src/lib/hr-policy-document-extraction.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs`
- `TEST_FILE=src/lib/hr-policy-imports.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs`
- `TEST_FILE=src/lib/hr-policy-library.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs`
- `TEST_FILE=src/routes/hr-policy-upload.test.ts pnpm --filter @workspace/api-server exec node run-tests.mjs`

These use fictional fixtures. The import lifecycle tests inject private-storage/scanner dependencies inside the test process only; they do not configure the running API or certify a real scanner installation.
