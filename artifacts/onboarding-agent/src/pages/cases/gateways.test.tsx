import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Router } from 'wouter';
import { GatewaysStrip } from './detail/gateways-strip';
import { NewCaseForm } from './index';

test('GatewaysStrip renders all three gates and enforces HR controls', () => {
  const mockCase = {
    id: 1,
    offerAcceptanceComplete: false,
    gateways: {
      a: { status: 'pending' as const, label: 'A Label', reason: 'A Reason' },
      b: { status: 'human-review' as const, label: 'B Label', reason: 'B Reason' },
      c: { status: 'blocked' as const, label: 'C Label', reason: 'C Reason' },
    }
  };

  const queryClient = new QueryClient();
  const dummyHook = () => ['/cases/1', () => {}] as [string, (path: string) => void];

  const render = (isHR: boolean) => renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Router hook={dummyHook}>
        <GatewaysStrip c={mockCase} isHR={isHR} />
      </Router>
    </QueryClientProvider>
  );

  const htmlHR = render(true);
  
  assert.match(htmlHR, /A Label/);
  assert.match(htmlHR, /B Label/);
  assert.match(htmlHR, /C Label/);
  assert.match(htmlHR, /View Pending Interventions/);
  assert.match(htmlHR, /Exceptions and blocked outcomes require human review/);
  assert.match(htmlHR, /Confirm Offer Package/);

  // Check non-HR hiding
  const htmlNonHR = render(false);
  assert.doesNotMatch(htmlNonHR, /Confirm Offer Package/, 'Non-HR should not see confirm button');
});

test('NewCaseForm checkbox payload structure', () => {
  const queryClient = new QueryClient();
  const dummyHook = () => ['/cases', () => {}] as [string, (path: string) => void];

  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <Router hook={dummyHook}>
        <NewCaseForm onClose={() => {}} />
      </Router>
    </QueryClientProvider>
  );
  
  assert.match(html, /<input type="checkbox"[^>]*name="offerAcceptanceComplete"/);
  assert.match(html, /Is the offer-acceptance package complete\?/);
  assert.match(html, /creates a preboarding hold/);
});