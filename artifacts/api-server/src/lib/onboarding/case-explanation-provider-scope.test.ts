import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyExplanationDispatch, PROVIDER_GOVERNANCE_WORKFLOW } from "./governance-provider-boundary";

const input = {
  caseRow: { id: 123 }, workflow: PROVIDER_GOVERNANCE_WORKFLOW.communication,
  providerId: "openai", operation: "onboarding-case-explainability:123:generation",
  readOnlyCaseAnalysis: true,
};

test("only explicit generation and verification use read-only explanation scope", () => {
  assert.equal(isReadOnlyExplanationDispatch(input), true);
  assert.equal(isReadOnlyExplanationDispatch({
    ...input, operation: "onboarding-case-explainability:123:verification",
  }), true);
});

test("analysis flag cannot authorize email, documents, another case or arbitrary model operations", () => {
  assert.equal(isReadOnlyExplanationDispatch({ ...input, readOnlyCaseAnalysis: false }), false);
  assert.equal(isReadOnlyExplanationDispatch({ ...input, providerId: "gmail" }), false);
  assert.equal(isReadOnlyExplanationDispatch({ ...input, workflow: PROVIDER_GOVERNANCE_WORKFLOW.documentProcessing }), false);
  assert.equal(isReadOnlyExplanationDispatch({ ...input, operation: "onboarding-case-explainability:456:generation" }), false);
  assert.equal(isReadOnlyExplanationDispatch({ ...input, operation: "send-candidate-email" }), false);
});
