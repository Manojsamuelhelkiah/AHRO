import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedEmailContent } from "./hro-email-content";
import { classifyEmail, validateEmailReview } from "./hro-email-registry";
import { runWithProviderDeny, externalProviderDispatchDenied } from "./onboarding/provider-policy";
import type { GmailMessage } from "./onboarding/inbound-email";
import { editorFixtures, editorFields, editorPlain } from "../test-utils/hro-email-editor-fixtures";

type Part = NonNullable<GmailMessage["payload"]>;
const part = (mimeType: string, text: string): Part => ({ mimeType, body: { data: Buffer.from(text).toString("base64url") } });
function extract(payload: Part) {
  return runWithProviderDeny(() => {
    assert.equal(externalProviderDispatchDenied(), true);
    const content = boundedEmailContent({
      id: "offline-editor-fixture", payload,
    } as GmailMessage);
    assert.equal(content.blocked, false);
    return { content, result: classifyEmail("", content.body, content.structure) };
  });
}
for (const fixture of editorFixtures) {
  test(`${fixture.id}: ${fixture.expectation} — ${fixture.reason}`, () => {
    const { result } = extract(part("text/html", fixture.html));
    assert.deepEqual(result.fields, fixture.expectedFields);
    if (fixture.issue) {
      assert.ok(result.issues.some(i => i.field === fixture.issue!.field && i.kind === fixture.issue!.kind));
      assert.ok(result.issues.every(i => i.message.trim()), "Review issues remain visible, not empty flags.");
    } else {
      assert.deepEqual(result.issues, []);
      assert.equal(result.templateId, "onboarding-external-fte");
      assert.deepEqual(result.missingFields, []);
      assert.equal(result.blockedReason, null);
      assert.equal(validateEmailReview(result.templateId!, result.fields).valid, true);
      for (const key of Object.keys(editorFields)) assert.ok(result.provenance[key].includes("html-table-1"), key);
    }
    assert.ok(!Object.values(result.fields).some(v => /Quoted|quoted-profile|quoted@/.test(v)));
  });
}
for (const fixture of editorFixtures.filter(f => f.expectation === "supported")) {
  for (const reversed of [false, true]) {
    test(`${fixture.editor}: equivalent MIME alternatives, HTML ${reversed ? "first" : "last"}`, () => {
      const parts = [part("text/plain", editorPlain), part("text/html", fixture.html)];
      const { result } = extract({ mimeType: "multipart/alternative", parts: reversed ? parts.reverse() : parts });
      assert.deepEqual(result.fields, editorFields);
      assert.deepEqual(result.issues, []);
      for (const key of Object.keys(editorFields)) {
        assert.ok(result.provenance[key].includes("plain-text"), key);
        assert.ok(result.provenance[key].includes("html-table-1"), key);
      }
    });
    test(`${fixture.editor}: conflicting MIME alternatives, HTML ${reversed ? "first" : "last"}`, () => {
      const parts = [part("text/plain", editorPlain.replace("Example Rowan", "Example Other").replace("work_country: US", "work_country: GB")),
        part("text/html", fixture.html)];
      const { result } = extract({ mimeType: "multipart/alternative", parts: reversed ? parts.reverse() : parts });
      const { worker_name: _name, work_country: _country, ...nonconflicting } = editorFields;
      assert.deepEqual(result.fields, nonconflicting, "Neither representation wins.");
      assert.deepEqual(result.issues.map(i => [i.field, i.kind]).sort(), [["work_country", "conflict"], ["worker_name", "conflict"]]);
      assert.ok(result.blockedReason);
      assert.equal(result.provenance.worker_name, undefined);
      assert.equal(result.provenance.work_country, undefined);
    });
  }
}
test("Outlook merged cells remain review-required without guessing field positions", () => {
  const fixture = editorFixtures.find(f => f.id === "Outlook-wrapped")!;
  const { result } = extract(part("text/html", fixture.html.replace('<td style=', '<td colspan="2" style=')));
  assert.deepEqual(result.fields, {});
  assert.ok(result.issues.some(i => i.kind === "malformed"));
});
test("forwarded message/rfc822 stays quarantined, not a second employee source", () => {
  const fixture = editorFixtures.find(f => f.id === "Apple Mail-wrapped")!;
  const { result, content } = extract({
    mimeType: "multipart/mixed", parts: [part("text/html", fixture.html), {
      mimeType: "message/rfc822",
      parts: [part("text/plain", editorPlain.replace("Example Rowan", "Example Quoted").replace("assisted_intake: yes", "assisted_intake: no"))],
    }],
  });
  assert.deepEqual(result.fields, editorFields);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(content.attachments, [{ name: "Private provider attachment", status: "quarantined-not-imported" }]);
  assert.ok(!content.scanContent.includes("Example Quoted"));
});
test("remote resources, scripts and attributes supply no employee facts and are never loaded", () => {
  const fixture = editorFixtures.find(f => f.id === "Gmail-wrapped")!;
  const { result, content } = extract(part("text/html", fixture.html +
    '<img src="https://tracking.example.invalid/pixel" alt="worker_name: Example Hidden">' +
    '<style>@import url("https://style.example.invalid/a"); worker_name: Example Hidden</style>' +
    '<script src="https://script.example.invalid/a">worker_name: Example Hidden</script>' +
    '<iframe src="https://frame.example.invalid/a">worker_name: Example Hidden</iframe>'));
  assert.deepEqual(result.fields, editorFields);
  assert.deepEqual(result.issues, []);
  assert.ok(!content.body.includes("Example Hidden"));
});
