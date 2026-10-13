import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lifecycleStageText } from './lifecycle-stage-presentation';
import { composeApprovalRequestEmail, composeApprovalDecisionEmail } from './approval-email-templates';
import { GUIDE_SECTIONS, PRODUCT_FEATURES, REQUIREMENTS } from './product-learning-catalog';

test('future approval emails use business stages without changing references or authority statements', () => {
  const request = composeApprovalRequestEmail({
    approvalId: 44, version: 3, workerName: 'Fixture', caseId: 21, agent: 'reviewer',
    hitlPattern: 'hard-block', recommendation: 'Review Gate A — offer-acceptance package',
    rationale: 'Gateway C is blocked; current evidence and HR approval are required.',
  });
  assert.match(request.body, /Offer-Acceptance Package/);
  assert.match(request.body, /Day-1 Readiness is blocked/);
  assert.match(request.body, /AP-44-V3/);
  assert.match(request.body, /do not approve, reject, or change this review/);
  const receipt = composeApprovalDecisionEmail({
    approvalId: 44, version: 3, workerName: 'Fixture', caseId: 21,
    decidedBy: 'Reviewer', decision: 'approved', decidedAt: new Date('2026-01-01T00:00:00Z'),
  });
  for (const email of [request, receipt]) assert.doesNotMatch(email.body, /\b(?:Gateway|Gate) [ABC]\b/);
  assert.match(receipt.body, /does not by itself claim that a stage was released/);
  assert.match(receipt.body, /current-evidence reconciliation/);
});

test('current guide/catalog export inputs consistently use business labels and retain safety language', () => {
  const currentCopy = JSON.stringify([GUIDE_SECTIONS, PRODUCT_FEATURES, REQUIREMENTS.map(r => r.expectedEvidence)]);
  assert.doesNotMatch(currentCopy, /\b(?:Gateway|Gate) [ABC]\b/);
  for (const label of ['Offer-Acceptance Package', 'Background Checks', 'Day-1 Readiness']) assert.ok(currentCopy.includes(label));
  assert.match(currentCopy, /A score or status label never substitutes for authority or safety gates/);
  assert.match(currentCopy, /Historical test records/);
});

test('presentation does not rename approval or historical outcome matching identifiers', () => {
  for (const [input, expected] of [
    ['Gate A — offer-acceptance package', 'Offer-Acceptance Package'],
    ['Gate B — background verification', 'Background Checks'],
    ['Gate C Day-1 readiness confirmed by HR', 'Day-1 Readiness confirmed by HR'],
    ['API Gateway / AI Gateway / BPMN gateway', 'API Gateway / AI Gateway / BPMN gateway'],
  ]) assert.equal(lifecycleStageText(input), expected);
  const engine = readFileSync('artifacts/api-server/src/lib/onboarding/engine.ts', 'utf8');
  assert.match(engine, /OFFER_ACCEPTANCE_GATE_RULE = "Gate A — offer-acceptance package"/);
  assert.match(engine, /DAY1_READINESS_GATE_RULE = "Gate C — Day-1 readiness confirmation"/);
  assert.match(engine, /title: "Gate C Day-1 readiness confirmed by HR"/);
  const separation = readFileSync('artifacts/onboarding-agent/src/pages/cases/separations/detail.tsx', 'utf8');
  assert.match(separation, /Separation Screening/);
  assert.match(separation, /Final Closure.*unavailable/);
  assert.doesNotMatch(separation, /Gateway [ABC]|Offer-Acceptance Package|Day-1 Readiness/);
});
