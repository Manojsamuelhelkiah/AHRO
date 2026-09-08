Source: https://github.com/Avature/intent-classification
Title: GitHub - Avature/intent-classification: This repository contains a test set designed for intent classification within the Human Resources domain. · GitHub
Fetched: 2026-09-08T16:20:30.025Z

[Skip to content](https://github.com/Avature/intent-classification#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/Avature/intent-classification) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/Avature/intent-classification) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/Avature/intent-classification) to refresh your session.Dismiss alert

{{ message }}

### Uh oh!

There was an error while loading. [Please reload this page](https://github.com/Avature/intent-classification).

[Avature](https://github.com/Avature)/ **[intent-classification](https://github.com/Avature/intent-classification)** Public

- [Notifications](https://github.com/login?return_to=%2FAvature%2Fintent-classification) You must be signed in to change notification settings
- [Fork\\
0](https://github.com/login?return_to=%2FAvature%2Fintent-classification)
- [Star\\
1](https://github.com/login?return_to=%2FAvature%2Fintent-classification)


main

[**1** Branch](https://github.com/Avature/intent-classification/branches) [**0** Tags](https://github.com/Avature/intent-classification/tags)

[Go to Branches page](https://github.com/Avature/intent-classification/branches)[Go to Tags page](https://github.com/Avature/intent-classification/tags)

Go to file

Code

Open more actions menu

## Latest commit

[![matiasditada](https://avatars.githubusercontent.com/u/2976872?v=4&size=40)](https://github.com/matiasditada)[matiasditada](https://github.com/Avature/intent-classification/commits?author=matiasditada)

[Add course-grained test set](https://github.com/Avature/intent-classification/commit/49b8a94701d23f6d9b4f5ea70d30f6eaeb5a1a25)

2 years agoMay 28, 2024

[49b8a94](https://github.com/Avature/intent-classification/commit/49b8a94701d23f6d9b4f5ea70d30f6eaeb5a1a25) · 2 years agoMay 28, 2024

## History

[2 Commits](https://github.com/Avature/intent-classification/commits/main/)

Open commit details

[View commit history for this file.](https://github.com/Avature/intent-classification/commits/main/) 2 Commits

## Folders and files

| Name | Name | Last commit message | Last commit date |
| --- | --- | --- | --- |
| [test\_set](https://github.com/Avature/intent-classification/tree/main/test_set "test_set") | [test\_set](https://github.com/Avature/intent-classification/tree/main/test_set "test_set") | [Add course-grained test set](https://github.com/Avature/intent-classification/commit/49b8a94701d23f6d9b4f5ea70d30f6eaeb5a1a25 "Add course-grained test set") | 2 years agoMay 28, 2024 |
| [LICENSE](https://github.com/Avature/intent-classification/blob/main/LICENSE "LICENSE") | [LICENSE](https://github.com/Avature/intent-classification/blob/main/LICENSE "LICENSE") | [Test set designed for intent classification](https://github.com/Avature/intent-classification/commit/2ec86e8bdd655f5a79c3539043260274d587d27b "Test set designed for intent classification") | 2 years agoMay 27, 2024 |
| [README.md](https://github.com/Avature/intent-classification/blob/main/README.md "README.md") | [README.md](https://github.com/Avature/intent-classification/blob/main/README.md "README.md") | [Add course-grained test set](https://github.com/Avature/intent-classification/commit/49b8a94701d23f6d9b4f5ea70d30f6eaeb5a1a25 "Add course-grained test set") | 2 years agoMay 28, 2024 |
| View all files |

## Repository files navigation

# Repository for Intent Classification

[Permalink: Repository for Intent Classification](https://github.com/Avature/intent-classification#repository-for-intent-classification)

This repository contains a test set designed for intent classification within the Human Resources domain.

The shared [**test set**](https://github.com/Avature/intent-classification/blob/main/test_set/intent_classification_fg_test_set.json) encompasses 34 different intents,
meticulously
identified by experts through iterative analysis of sample conversations in English.
The data is stored in JSON format, with a dictionary mapping each intent to its corresponding samples. Company names are
anonymized and replaced by the placeholder `[company_name]`.

The procedure involved the collaboration of two annotators, achieving an inter-annotator agreement of 92% between them.
In instances of disagreement, an adjudicator was consulted to render the final decision.

We also provide a [**course-grained test set**](https://github.com/Avature/intent-classification/blob/main/test_set/intent_classification_cg_test_set.json), which is the result
collapsing the 34 intents to just 8 labels by following a set
of custom [transformation rules](https://github.com/Avature/intent-classification/blob/main/test_set/transformation_rules.json).

## General Statistics

[Permalink: General Statistics](https://github.com/Avature/intent-classification#general-statistics)

This section provides statistics on the test set, including the distribution of samples per intent.

For the fine-grained test set:

```
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

```
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

[Permalink: Reference](https://github.com/Avature/intent-classification#reference)

This data correspond to the paper:

**Intent Classification Methods for Human Resources Chatbots**

Lucas Alvarez Lacasa, Martín Dévora-Pajares, Rabih Zbib and Hermenegildo Fabregat.

To be presented at the 40th International Conference of the Spanish Society for Natural Language Processing and to
appear at the journal _Procesamiento del Lenguaje Natural_, September 2023.

If you use these data, please include the following reference:

```
@article{lacasa2024intentclassification,
  title={Intent Classification Methods for Human Resources Chatbots},
  author={Lucas Alvarez Lacasa, Martín D{\'\e}vora-Pajares, Rabih Zbib, Hermenegildo Fabregat},
  journal={Procesamiento del Lenguaje Natural},
  number={73},
  year={2024},
  publisher={Sociedad Espa{\~n}ola para el Procesamiento del Lenguaje Natural}
}
```

## About

This repository contains a test set designed for intent classification within the Human Resources domain.

### Resources

[Readme](https://github.com/Avature/intent-classification#readme-ov-file)

[Apache-2.0 license](https://github.com/Avature/intent-classification#Apache-2.0-1-ov-file)

[Activity](https://github.com/Avature/intent-classification/activity)

[Custom properties](https://github.com/Avature/intent-classification/custom-properties)

### Stars

**1** star

### Watchers

**2** watching

### Forks

[**0** forks](https://github.com/Avature/intent-classification/forks)

[Report repository](https://github.com/contact/report-content?content_url=https%3A%2F%2Fgithub.com%2FAvature%2Fintent-classification&report=Avature+%28user%29)

## Releases

## Packages

## Contributors

You can’t perform that action at this time.