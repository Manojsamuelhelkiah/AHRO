# Shared security and AI assurance documentation

`assurance_content.py` is the shared content source for the business guide, the
two-page security-leadership brief and the detailed control/evidence register.
Source pointers identify implementation boundaries. Test pointers identify nearby
tests; they do not assert that a suite was run or passed.

Illustrative fictional stories and case-execution tools have been retired.
The 50 controls, safe behavior, source pointers, evidence requirements and
limitations remain. Validation reconciles these across PDF, HTML and JSON copies.
Historical records remain restricted, read-only and non-operational; no data is purged.

Build and check:

```sh
python docs/business-user-explainer/build_pdf.py
python docs/business-user-explainer/verify_pdf.py
```

Generated PDFs, a structured inventory and a standalone browser reader are written
to `deliverables/`. The builder also synchronizes the PDF and HTML copies in the
Control Tower's public directory. These are static documentation
assets; they contain no tenant records, credentials or live operational values.

Do not convert roadmap or unverified deployment facts to implemented assurance
without current evidence. Do not treat recorded operational indicators as accuracy,
fairness, certification or comprehensive effectiveness measurements. Refresh the
review date and content together when the reviewed implementation changes.
