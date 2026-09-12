import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { dkimSign, type DNSResolver } from "mailauth";
import {
  isVerifiedGmailDkimTransport,
  verifyGmailApprovalTransport,
} from "./verified-email-transport";

const reference = "AP-42-V1";
const from = "approver@example.test";

async function signedFixture(input?: {
  from?: string;
  body?: string;
  maxBodyLength?: number;
}): Promise<{ message: string; resolver: DNSResolver }> {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const message = [
    `From: HR Approver <${input?.from ?? from}>`,
    "To: onboarding@example.test",
    `Subject: [${reference}] Decision required`,
    "Date: Tue, 01 Jan 2030 00:00:00 +0000",
    "",
    input?.body ?? `${reference}\r\napprove`,
    "",
  ].join("\r\n");
  const signingKey = privateKey.export({ type: "pkcs1", format: "pem" });
  const signed = await dkimSign(message, {
    signingDomain: "example.test",
    selector: "unit",
    privateKey: signingKey,
    signatureData: [{
      signingDomain: "example.test",
      selector: "unit",
      privateKey: signingKey,
      headerList: ["from", "subject"],
      ...(input?.maxBodyLength === undefined ? {} : { maxBodyLength: input.maxBodyLength }),
    }],
  });
  assert.deepEqual(signed.errors, []);
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    message: `${signed.signatures}${message}`,
    resolver: async (domain) => {
      assert.equal(domain, "unit._domainkey.example.test");
      return [[`v=DKIM1; k=rsa; p=${key}`]];
    },
  };
}

async function verify(message: string, resolver: DNSResolver, expectedFromAddress = from) {
  return verifyGmailApprovalTransport({
    rawMessage: message,
    sourceMessageId: "gmail-unit-1",
    expectedFromAddress,
    expectedReference: reference,
    expectedDecisionText: "approve",
    expectedDecision: "approved",
    resolver,
  });
}

test("valid raw Gmail fixture requires a DNS-verified aligned DKIM signature", async () => {
  const fixture = await signedFixture();
  const proof = await verify(fixture.message, fixture.resolver);
  assert.ok(proof);
  assert.equal(proof.fromAddress, from);
  assert.equal(proof.signingDomain, "example.test");
  assert.equal(isVerifiedGmailDkimTransport(proof, {
    fromAddress: from,
    sourceMessageId: "gmail-unit-1",
    approvalReference: reference,
    decision: "approved",
  }), true);
  assert.equal(isVerifiedGmailDkimTransport({ verified: true, fromAddress: from }, {
    fromAddress: from,
    sourceMessageId: "gmail-unit-1",
    approvalReference: reference,
    decision: "approved",
  }), false, "a caller-provided boolean cannot impersonate verified transport");
});

test("spoofed From is rejected even when another domain signs the raw message", async () => {
  const fixture = await signedFixture({ from: "mallory@example.test" });
  assert.equal(await verify(fixture.message, fixture.resolver), null);
});

test("no DKIM and injected Authentication-Results never establish remote identity", async () => {
  const raw = [
    `From: HR Approver <${from}>`,
    `Subject: [${reference}]`,
    "Authentication-Results: attacker.invalid; dkim=pass header.d=example.test",
    "",
    reference,
    "approve",
  ].join("\r\n");
  const resolver: DNSResolver = async () => {
    throw new Error("DNS must not be consulted without a DKIM signature");
  };
  assert.equal(await verify(raw, resolver), null);
});

test("changed decision body fails DKIM verification", async () => {
  const fixture = await signedFixture();
  const changed = fixture.message.replace("\r\napprove\r\n", "\r\nreject\r\n");
  assert.equal(await verify(changed, fixture.resolver), null);
});

test("a partial-body DKIM signature is rejected even when cryptographically valid", async () => {
  const fixture = await signedFixture({ maxBodyLength: 1 });
  assert.equal(await verify(fixture.message, fixture.resolver), null);
});