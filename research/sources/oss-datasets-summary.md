# Open-source HR intent/chatbot dataset research

Access date: **2026-09-08**. Scope: public dataset pages outside GitHub, with a strict distinction between HR employee-service dialogue/intent resources and generic intent or HR analytics resources.

## Key facts

1. **[HR-Multiwoz on Hugging Face](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd)** is the strongest identified HR employee-service candidate. Its card says it has **550 fully labeled conversations across 10 HR domains**, is intended to evaluate transfer learning for task-oriented dialogue / schema-guided dialogue, and is **MIT** licensed. It is HR domain data, though the card also says it is synthetic and not intended for training.
2. **[HR-practitioner-seed-v1 on Hugging Face](https://huggingface.co/datasets/15juneee/hr-practitioner-seed-v1)** is HR content with a stated **Apache-2.0** license and traceable upstream sources. It is a prompt/context/completion/task resource for recruiting and HR-policy work—not a concise employee-service intent classifier benchmark.
3. **[English Human Resources Basics 30 on Hugging Face](https://huggingface.co/datasets/fvandi/english-human-resources-basics-30)** is 30 HR Q&A-style instruction/response rows. It is HR topical content, but has neither a documented license/provenance nor intent labels.
4. **[Chatbot Intent Classification Dataset on Kaggle](https://www.kaggle.com/datasets/sahideseker/chatbot-intent-classification-dataset)** is a stable, fetched Kaggle page with 1,000 synthetic `user_input`/`intent` examples and **CC BY-SA 4.0**. Its labels are retail/general-support examples, so it is a generic intent dataset, **not HR**.
5. **[IBM HR Analytics Employee Attrition & Performance on Kaggle](https://www.kaggle.com/datasets/pavansubhasht/ibm-hr-analytics-attrition-dataset)** is an HR analytics/attrition candidate only. The saved snippets support neither its license nor a text-intent schema; it cannot support a claim about employee-service intent labels.

## Exact taxonomy labels / features supported by evidence

### HR-Multiwoz: genuine HR task/service taxonomy

- Fields: `dialogue_id`, `service`, `turn_id`, `speaker`, `utterance`, and `state`.
- Speaker coding: `0` is HR Assistant and `1` is Employee.
- The `service` field carries the HR area label; visible examples include `access_request`, `relocation_request`, `benefits_enrollment`, `time_off_report`, `training_request`, `goal_setting`, and `performance_review`.
- `state` preserves per-turn entities/answers. For example, a training request includes fields such as `training_topic`, `special_requirements`, `number_of_participants`, `training_duration`, `budget_constraints`, and `preferred_training_dates`.
- The card asserts 10 HR domains, but its fetched text does not provide one canonical enumerated list of all ten. Do not infer missing names.

### HR-practitioner-seed-v1: HR task labels, not employee-service intents

- Fields: `prompt`, `context`, `completion`, `source`, `license`, and `task`.
- The card states 21 task types. Its named grounded task types are job-description rewriting, requirement extraction, competency-based interview-question generation, screening-rubric design, candidate-rejection communication, hiring-manager summarisation, inclusive-language review, and passive-candidate outreach.
- This is useful for recruiting/policy generation; its `task` values are not evidence of a conversational employee-service intent taxonomy.

### English Human Resources Basics 30: no taxonomy

- Fields: `instruction` and `response`, both strings; 30 rows.
- Examples cover HR concepts such as recruitment, payroll, performance management, labor law, employee relations, conflict resolution, and attendance management.
- These are Q&A topics/definitions, not a labeled intent field.

### Kaggle generic chatbot intents: genuine intent field, wrong domain

- Fields: `user_input` (short chatbot-user message) and `intent` (identified user intent).
- The fetched page explicitly names `order_status`, `cancellation`, `password_reset`, `account_help`, `return_request`, `business_hours`, `payment_update`, `service_info`, and `technical_support`.
- Those examples establish generic retail/account/support intent recognition, not HR.

### Kaggle IBM attrition: no supported intent taxonomy

- Search-only evidence describes 1,470 employees and 35 attributes in an attrition analysis.
- There is no supported `utterance`, `intent`, dialogue, or service-label field in the captured evidence. Treat it as analytics/frequency data, not taxonomy evidence.

## Source quality, licensing, and provenance

| Source | Domain assessment | Provenance | License | Quality assessment |
|---|---|---|---|---|
| HR-Multiwoz (HF) | Direct HR employee/assistant task-oriented dialogue | Card links the 2024 HR-MultiWOZ paper; says an LLM-based collection pipeline with minimal human annotation; synthetic problems | MIT | Best fit and explicit license; verify intended-use restriction before training |
| HR-practitioner-seed-v1 (HF) | HR recruiting/policy prompts; not intent routing | Card identifies three upstream datasets plus authored content | Apache-2.0 (card says this is the most restrictive upstream license) | Strong provenance disclosure, but task-generation rather than employee-service intents |
| English HR Basics 30 (HF) | HR Q&A; not intents | Not documented; README empty | Not documented | Weak reuse suitability despite topical relevance |
| Kaggle Chatbot Intent Classification | General chatbot/customer-service, not HR | Declared synthetic | CC BY-SA 4.0 | Clear schema/license and usable as a generic comparator only |
| Kaggle IBM HR Attrition | HR analytics, not intents | Unverified from saved search snippets | Unverified from saved search snippets | Do not use for labeling or licensing claims |

## Conflicts and cautions

- HR-Multiwoz calls itself fully labeled and open sourced, but also says it is synthetic and “not intended for use in training.” Those conditions matter more than the MIT label alone for a training-use decision.
- “HR dataset” does not mean “HR intent dataset.” HR-practitioner and HR Basics concern HR content, but do not expose employee-service intent labels.
- “Intent dataset” does not mean “HR dataset.” Kaggle Chatbot Intent Classification has explicit labels but its visible examples are order/account/payment/support requests.
- Search results around Kaggle attrition frequently conflate data, notebooks, and analyses. The captured results do not prove the underlying Kaggle dataset’s license or exact features.

## Gaps

- No fetched source yielded a complete canonical list of all 10 HR-Multiwoz service/domain labels.
- No live employee-origin HR service-intent corpus with both explicit licensing and verified non-synthetic provenance was found in this pass.
- Kaggle attrition metadata/schema/license remain unverified where only the search snippets are available.
- Before production use, download/review the actual files, license text, intended-use terms, privacy assessment, class counts, and label definitions; source cards alone do not establish fitness for a particular employer.

## Sources and saved evidence

1. [HR-Multiwoz dataset card](https://huggingface.co/datasets/xwjzds/hr_multiwoz_tod_sgd) — `research/sources/oss-datasets-01-hr-multiwoz.md`
2. [HR-practitioner-seed-v1 dataset card](https://huggingface.co/datasets/15juneee/hr-practitioner-seed-v1) — `research/sources/oss-datasets-02-hr-practitioner.md`
3. [English Human Resources Basics 30 dataset card](https://huggingface.co/datasets/fvandi/english-human-resources-basics-30) — `research/sources/oss-datasets-03-hr-basics.md`
4. [Kaggle Chatbot Intent Classification Dataset](https://www.kaggle.com/datasets/sahideseker/chatbot-intent-classification-dataset) — `research/sources/oss-datasets-04-kaggle-chatbot-intents.md`
5. [Kaggle IBM HR Analytics Employee Attrition & Performance](https://www.kaggle.com/datasets/pavansubhasht/ibm-hr-analytics-attrition-dataset) — `research/sources/oss-datasets-snippets.md`
6. [Kaggle HR Employee Attrition Analysis](https://www.kaggle.com/code/sarahbarkire/hr-employee-attrition-analysis) — `research/sources/oss-datasets-snippets.md`
