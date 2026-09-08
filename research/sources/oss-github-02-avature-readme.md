Source: https://raw.githubusercontent.com/Avature/intent-classification/master/README.md
Title: 
Fetched: 2026-09-08T16:20:33.753Z

# Repository for Intent Classification

This repository contains a test set designed for intent classification within the Human Resources domain.

The shared [**test set**](./test_set/intent_classification_fg_test_set.json) encompasses 34 different intents,
meticulously
identified by experts through iterative analysis of sample conversations in English.
The data is stored in JSON format, with a dictionary mapping each intent to its corresponding samples. Company names are
anonymized and replaced by the placeholder `[company_name]`.

The procedure involved the collaboration of two annotators, achieving an inter-annotator agreement of 92% between them.
In instances of disagreement, an adjudicator was consulted to render the final decision.

We also provide a [**course-grained test set**](./test_set/intent_classification_cg_test_set.json), which is the result
collapsing the 34 intents to just 8 labels by following a set
of custom [transformation rules](./test_set/transformation_rules.json).

## General Statistics

This section provides statistics on the test set, including the distribution of samples per intent.

For the fine-grained test set:

```json
{
  "global_metrics": {
    "total_intents": 34,
    "total_samples": 1199,
    "total_intents_with_entities": 0,
    "total_entities": 0,
    "intent_to_samples_dist": {
      "faq_recruiting_process": 62,
      "faq_job_requirements": 58,
      "faq_company_culture": 57,
      "faq_remote_work_policy": 56,
      "faq_salary_conversation": 56,
      "talk_to_human": 47,
      "faq_about_company": 46,
      "faq_pto_policy": 46,
      "user_wants_job_recommendations": 45,
      "appreciation": 45,
      "faq_company_teams": 43,
      "user_frustration": 40,
      "faq_company_size": 39,
      "faq_company_benefits": 37,
      "bot_capabilities": 36,
      "faq_diversity_inclusion_policy": 36,
      "faq_company_leadership": 36,
      "faq_company_location": 33,
      "faq_about_company_vision": 32,
      "faq_maternity_paternity_policy": 30,
      "faq_career_development": 29,
      "deny": 28,
      "faq_office_amenities": 28,
      "bot_challenge": 27,
      "faq_company_application_reasons": 26,
      "faq_company_values": 26,
      "user_wants_to_escape_form": 26,
      "faq_solutions_offered": 25,
      "bot_languages": 24,
      "bot_mood": 20,
      "affirm": 17,
      "ask_name": 15,
      "goodbye": 15,
      "greet": 13
    }
  },
  "sample_to_dup_intents": {},
  "intent_to_dup_samples": {}
}
```

For the course-grained test set:

```json
{
  "global_metrics": {
    "total_intents": 8,
    "total_samples": 1199,
    "total_intents_with_entities": 0,
    "total_entities": 0,
    "intent_to_samples_dist": {
      "faq": 743,
      "small_talk": 235,
      "job_question": 58,
      "talk_to_human": 47,
      "job_search": 45,
      "negative_ack": 28,
      "exit_form": 26,
      "positive_ack": 17
    }
  },
  "sample_to_dup_intents": {},
  "intent_to_dup_samples": {}
}
```

## Reference

This data correspond to the paper:

**Intent Classification Methods for Human Resources Chatbots**

Lucas Alvarez Lacasa, Martín Dévora-Pajares, Rabih Zbib and Hermenegildo Fabregat.

To be presented at the 40th International Conference of the Spanish Society for Natural Language Processing and to
appear at the journal _Procesamiento del Lenguaje Natural_, September 2023.

If you use these data, please include the following reference:

	@article{lacasa2024intentclassification,
	  title={Intent Classification Methods for Human Resources Chatbots},
	  author={Lucas Alvarez Lacasa, Martín D{\'\e}vora-Pajares, Rabih Zbib, Hermenegildo Fabregat},
	  journal={Procesamiento del Lenguaje Natural},
	  number={73},
	  year={2024},
	  publisher={Sociedad Espa{\~n}ola para el Procesamiento del Lenguaje Natural}
	}
