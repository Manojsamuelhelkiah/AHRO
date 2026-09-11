import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SetupRequestInstructions } from "./access-setup";

function renderRequest(approved: boolean, confirmed = false, expired = false) {
  return renderToStaticMarkup(<SetupRequestInstructions
    state={{
      eligible: true,
      reason: null,
      completed: false,
      request: {
        requestId: "test-request",
        approvalValue: "a".repeat(64),
        expiresAt: expired ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
        approved,
      },
    }}
    confirmed={confirmed} setConfirmed={() => {}}
    copyMessage="" onCopy={() => {}} checking={false} onCheck={() => {}}
    completing={false} onComplete={() => {}}
  />);
}

test("unapproved setup explains private operator approval without offering completion", () => {
  const html = renderRequest(false);
  assert.match(html, /DEMO_CONTROLLER_SETUP_APPROVAL/);
  assert.match(html, /Deployment secrets/);
  assert.match(html, /Do not send passwords, internal user IDs/);
  assert.match(html, /Waiting for explicit project operator approval/);
  assert.doesNotMatch(html, /Confirm and enable Demo access/);
});

test("approved setup still requires explicit user confirmation", () => {
  const html = renderRequest(true);
  assert.match(html, /Your membership has not changed yet/);
  assert.match(html, /not access to any other organization/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm and enable Demo access/);
  const confirmed = renderRequest(true, true);
  assert.doesNotMatch(confirmed, /<button[^>]*disabled=""[^>]*>Confirm and enable Demo access/);
});

test("expiry removes completion even if the previous approval response was true", () => {
  const html = renderRequest(true, true, true);
  assert.match(html, /This request has expired/);
  assert.doesNotMatch(html, /Confirm and enable Demo access/);
});