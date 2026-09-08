# Open-source GitHub HR chatbot / intent-data screen

**Access date:** 2026-09-08  
**Scope:** GitHub repositories represented as HR chatbots or HR datasets were screened for (1) actual labeled intent-to-utterance data and (2) an explicit repository license. This is a research/provenance screen, not legal advice. “Allowed” below describes what the stated repository license appears to permit, subject to its conditions and to any rights in the data.

## Key facts

### Qualifying dataset: Avature/intent-classification

- **Repository:** [Avature/intent-classification](https://github.com/Avature/intent-classification)
- **Access point / revision:** `main`, latest visible commit `49b8a94` / `49b8a94701d23f6d9b4f5ea70d30f6eaeb5a1a25` (2024-05-28); the repository page showed no tags. [Evidence: `oss-github-01-avature-intent-classification.md`, lines 24-44.]
- **What is available:** two JSON test sets: `test_set/intent_classification_fg_test_set.json` and `test_set/intent_classification_cg_test_set.json`; the README says each is a dictionary mapping intent to samples, and says the examples are English and company names are anonymized as `[company_name]`. It reports **1,199 utterance samples**, 34 fine-grained intents, and an 8-label collapsed set. [Evidence: `oss-github-01-avature-intent-classification.md`, lines 69-82 and 90-163; raw README duplicate at `oss-github-02-avature-readme.md`, lines 7-20 and 26-99.]
- **Exact taxonomy labels / features supported:** the exact fine labels are `faq_recruiting_process`, `faq_job_requirements`, `faq_company_culture`, `faq_remote_work_policy`, `faq_salary_conversation`, `talk_to_human`, `faq_about_company`, `faq_pto_policy`, `user_wants_job_recommendations`, `appreciation`, `faq_company_teams`, `user_frustration`, `faq_company_size`, `faq_company_benefits`, `bot_capabilities`, `faq_diversity_inclusion_policy`, `faq_company_leadership`, `faq_company_location`, `faq_about_company_vision`, `faq_maternity_paternity_policy`, `faq_career_development`, `deny`, `faq_office_amenities`, `bot_challenge`, `faq_company_application_reasons`, `faq_company_values`, `user_wants_to_escape_form`, `faq_solutions_offered`, `bot_languages`, `bot_mood`, `affirm`, `ask_name`, `goodbye`, and `greet`. Coarse labels are `faq`, `small_talk`, `job_question`, `talk_to_human`, `job_search`, `negative_ack`, `exit_form`, and `positive_ack`. [Evidence: `oss-github-02-avature-readme.md`, lines 35-70 and 81-99.]
- **Relevance to a 60-intent catalog:** directly supports recruiting/application process, job requirements, candidate job recommendations/search, company information (culture, teams, size, benefits, D&I, leadership, locations, vision, values), remote-work, salary-conversation, PTO, parental leave, career development, office amenities, live-agent escalation, and conversational fallback/control intents. It does **not** establish support for a generic 60-label catalog beyond those exact labels.
- **License:** the GitHub repository identifies an **Apache-2.0** license and includes a `LICENSE` file. [Evidence: `oss-github-01-avature-intent-classification.md`, lines 58-60 and 192-201.]
- **Redistribution/adaptation indication:** Apache-2.0 is an explicit permissive license and on its face includes rights to reproduce and distribute derivative works, with notice/license conditions. This appears favorable for redistribution/adaptation of repository content, but confirm that the `LICENSE` applies to the data files and satisfy all license conditions; no legal conclusion is made.
- **Provenance / quality:** strongest source in this screen: the repository expressly says it is an HR intent-classification test set, describes expert iterative identification, two annotators, 92% inter-annotator agreement, adjudication, and cites a 2024 paper. It is nevertheless a **test set**, not declared training data. [Evidence: `oss-github-01-avature-intent-classification.md`, lines 69-82 and 170-189.]

## Independently identified alternatives screened

| Repository | Access point visible | HR evidence and utterance/label result | License and adaptation/redistribution indication | Outcome |
| --- | --- | --- | --- | --- |
| [syncora-ai/hr-policies-qa-dataset](https://github.com/syncora-ai/hr-policies-qa-dataset) | `main`; latest visible commit `e9b8c64` / `e9b8c6430371f2a4e82b4d59547fac472af47758`, 2025-09-04; no tags visible. | Explicitly synthetic HR/compliance employee–assistant conversations; `dataset output.jsonl` is listed. Schema is `role`, `content`, and grouped `messages`, i.e., dialogue snippets, **not intent labels**. It is useful as HR Q&A/dialogue material but does not meet the intent-labeled-utterance requirement. | GitHub identifies MIT. MIT is permissive on its face, but README simultaneously says intended “solely for research, educational, and experimental use”; that statement conflicts with or at least creates uncertainty alongside the license. Do not infer unrestricted production/data reuse without review. | **Reject as an intent taxonomy source; retain as a clearly licensed synthetic HR Q&A lead.** Evidence: `oss-github-03-syncora-hr-policies-qa.md`, lines 20-57, 66-70, 96-102, 173-189. |
| [Sajjad-Amjad/HR-Chatbot](https://github.com/Sajjad-Amjad/HR-Chatbot) | `main`; latest visible commit `d7fd6bc` / `d7fd6bcc65cb98e0d309fe7f0ccbd687239a373a`, 2024-07-28; no tags visible. | HR chatbot application, but README says runtime GPT-4 prompt classification into general inquiries, HR/payroll questions, and grievances. The visible root list has a `data` directory but no exposed labeled corpus in the inspected page; no static utterance-label dataset was established. | No `LICENSE` is visible in the root listing and no license resource is shown. Redistribution/adaptation is **unknown; do not assume permission**. | **Reject.** Evidence: `oss-github-04-sajjad-hr-chatbot.md`, lines 20-62, 75-100, 186-194. |
| [SandeepGitGuy/Hiring_Assistant_Chatbot](https://github.com/SandeepGitGuy/Hiring_Assistant_Chatbot) | Search result reports `main`; created 2025-01-08; 9 commits. No commit SHA or tag was inspected. | Search discovery result calls it an “intelligent Hiring Assistant chatbot,” but supplies no data-file, utterance, or label evidence. | Search result reports MIT, but the LICENSE text was not fetched/inspected. Adaptation/redistribution remains unverified. | **Discovery-only; not a qualifying dataset.** Evidence: `oss-github-snippets.md`, source S5. |
| [trancethehuman/hr-gpt](https://github.com/trancethehuman/hr-gpt) | Search result reports `main`; created 2023-04-29; 43 commits. No commit SHA or tag was inspected. | Search discovery result describes an AI HR Slack agent, not an intent corpus; it supplies no utterance/label evidence. | Search result says “View license,” not a named license. Adaptation/redistribution unknown. | **Discovery-only; not a qualifying dataset.** Evidence: `oss-github-snippets.md`, source S6. |

## Source quality and licensing/provenance assessment

1. **Avature is the only qualifying result in this limited GitHub screen.** It has direct first-party repository, README, data-file, data-size, taxonomy, method, commit, and explicit-license evidence. The evidence supports use as a labeled HR *evaluation/test* corpus; it does not convert it into a training corpus.
2. **Syncora is a clearly HR-specific synthetic dataset with MIT shown by GitHub, but its own README schema lacks an intent field.** Its explicit research/educational/experimental-use statement should be treated as a material licensing/provenance ambiguity, even though MIT is displayed.
3. **The remaining alternatives are intentionally not represented as evidence for HR intent labels.** They are application/repository leads only. The search snippets are retained so the negative screen is reproducible.

## Conflicts

- **Avature README raw URL vs visible branch:** the raw README was fetched from `master`, while the repository page visibly names `main`. The content is substantively the same in the fetched evidence, but future retrieval should pin a commit SHA rather than rely on either moving branch name.
- **Syncora:** GitHub displays MIT, while the README says the dataset is intended “solely for research, educational, and experimental use.” The relationship between that statement and the MIT grant is not resolved here.
- **“Open source repository” is not enough:** a public repo or an application’s code license does not by itself prove rights in every included data file, or that data are intent-labeled.

## Gaps

- No definition/list of the “60 current catalog” was included with this research assignment. Therefore this report maps only by the exact public Avature label strings and explicit HR concepts, rather than claiming one-to-one coverage of unnamed internal intents.
- The Avature raw JSON and LICENSE body were linked and their existence/license were evidenced by GitHub, but the raw JSON utterance text and full Apache notice were not separately fetched in this pass.
- Four targeted pages were fetched, as requested. Other candidate repositories in `oss-github-snippets.md` are only search-discovery evidence, not verified datasets; do not promote them without inspecting their README, data files, and license.

## Sources and evidence paths

1. Avature repository landing page — https://github.com/Avature/intent-classification — `research/sources/oss-github-01-avature-intent-classification.md`
2. Avature raw README — https://raw.githubusercontent.com/Avature/intent-classification/master/README.md — `research/sources/oss-github-02-avature-readme.md`
3. Syncora HR Policies Q&A repository — https://github.com/syncora-ai/hr-policies-qa-dataset — `research/sources/oss-github-03-syncora-hr-policies-qa.md`
4. Sajjad-Amjad HR-Chatbot repository — https://github.com/Sajjad-Amjad/HR-Chatbot — `research/sources/oss-github-04-sajjad-hr-chatbot.md`
5. SandeepGitGuy Hiring Assistant discovery result — https://github.com/SandeepGitGuy/Hiring_Assistant_Chatbot — `research/sources/oss-github-snippets.md` (S5)
6. trancethehuman/hr-gpt discovery result — https://github.com/trancethehuman/hr-gpt — `research/sources/oss-github-snippets.md` (S6)