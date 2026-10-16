---
name: Workforce early-warning product scope
description: Requested employee attrition and candidate resume integrity signals and human follow-up surfaces
---

The user wants a “Talent at Risk” capability using persistent employee context and ML predictions, with red/amber/green indicators and recommended human follow-up in Analytics. Critical signals should be eligible to appear as actionable cases in the case pipeline and dashboard. Candidate resume integrity concerns are a separate requested review work-item type; they may share infrastructure but need not use the same model.

**Why:** The stated product goal is proactive intervention by a CHRO or HR user, rather than only reporting historical outcomes or displaying a score without a follow-up path.

**How to apply:** Preserve both Analytics and operational case/dashboard coverage when scoping this capability. Distinguish an actual validated model prediction from an illustrative or rule-based signal, and frame resume concerns as matters for verification rather than established misconduct. These requirements do not establish that trained models or suitable training data already exist.

The user selected a model-ready foundation before model training or connecting an existing prediction API. Disconnected model indicators must say “Not assessed”; a human's chosen review priority is not a model prediction.

**Why:** No supplied trained model or usable training dataset was established when the first-release scope was chosen. Presenting hand-entered priorities or sample values as ML predictions would misrepresent the product.

**How to apply:** Keep human reviews usable independently, but require real model integration and validation before claiming predictive attrition scores or resume-integrity results. Treat existing HRO case coverage as case coverage, not evidence that a complete employee history exists.
