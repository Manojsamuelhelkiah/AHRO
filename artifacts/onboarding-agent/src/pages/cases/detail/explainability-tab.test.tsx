import { test } from 'node:test';
import assert from 'node:assert';
import React, { useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExplainabilityTab, getActiveSessionScope, analysisErrorFeedback } from './explainability-tab';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pinOrganizationIdForPage } from '@workspace/api-client-react';

test('analysis restrictions use specific guidance without retry and discard old sources', () => {
  const feedback = analysisErrorFeedback({ status: 403, message: 'HTTP error', data: {
    message: 'AI provider approval is required.', retryable: false,
  } });
  assert.deepStrictEqual(feedback, { message: 'AI provider approval is required.', retryable: false, clearSources: true });
  assert.strictEqual(analysisErrorFeedback({ status: 503 }).retryable, true);
  assert.strictEqual(analysisErrorFeedback({ status: 429 }).retryable, true);
  assert.strictEqual(analysisErrorFeedback({ status: 410 }).retryable, false);
});

test('ExplainabilityTab renders correctly', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ExplainabilityTab caseId={1} userId="user-a" />
    </QueryClientProvider>
  );

  assert.ok(html.includes('What would you like to know?'));
  assert.ok(html.includes('Ask about case status'));
});

test('ExplainabilityTab clears memory across org/user boundaries', () => {
  const queryClient = new QueryClient();

  // Organization A, User 1
  pinOrganizationIdForPage('org-a');
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ExplainabilityTab caseId={1} userId="user-1" />
    </QueryClientProvider>
  );
  assert.strictEqual(getActiveSessionScope(), 'org-a-user-1');

  // Same org, User 2 (should reset active session scope)
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ExplainabilityTab caseId={1} userId="user-2" />
    </QueryClientProvider>
  );
  assert.strictEqual(getActiveSessionScope(), 'org-a-user-2');

  // New org, same User 2 (should reset active session scope)
  pinOrganizationIdForPage('org-b');
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ExplainabilityTab caseId={1} userId="user-2" />
    </QueryClientProvider>
  );
  assert.strictEqual(getActiveSessionScope(), 'org-b-user-2');
});
