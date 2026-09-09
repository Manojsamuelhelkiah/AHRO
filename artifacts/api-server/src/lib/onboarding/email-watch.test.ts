import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { matchCheckByRef, parseStatusEmail, processWatchMessageRefs, senderTrusted } from "./email-watch";

describe("parseStatusEmail", () => {
  test("classifies completed-sounding emails", () => {
    assert.equal(parseStatusEmail("RITM-1010 has been completed"), "completed");
    assert.equal(parseStatusEmail("BGV-1042: candidate cleared"), "completed");
    assert.equal(
      parseStatusEmail("Payroll setup PROCESSED successfully"),
      "completed",
    );
    assert.equal(parseStatusEmail("Ticket resolved and closed"), "completed");
  });

  test("classifies exception-sounding emails", () => {
    assert.equal(parseStatusEmail("BGV-1042 exception raised"), "exception");
    assert.equal(
      parseStatusEmail("Verification failed — discrepancy found"),
      "exception",
    );
    assert.equal(parseStatusEmail("Request rejected by approver"), "exception");
    assert.equal(
      parseStatusEmail("We are unable to verify employment"),
      "exception",
    );
  });

  test("exception wins over completed", () => {
    assert.equal(
      parseStatusEmail("Verification completed with exceptions"),
      "exception",
    );
    assert.equal(
      parseStatusEmail("Check cleared but a discrepancy was noted"),
      "exception",
    );
  });

  test("everything else is a progress update", () => {
    assert.equal(
      parseStatusEmail("RITM-1010 is in progress, ETA Friday"),
      "update",
    );
    assert.equal(parseStatusEmail("We received your request"), "update");
  });
});

describe("matchCheckByRef", () => {
  const checks = [
    { externalRef: "BGV-1042" },
    { externalRef: "RITM-1042" },
    { externalRef: "PAY-1043" },
  ];

  test("matches by reference in subject or body, case-insensitive", () => {
    assert.equal(
      matchCheckByRef(checks, "Re: ritm-1042 update")?.externalRef,
      "RITM-1042",
    );
    assert.equal(
      matchCheckByRef(checks, "Status for reference PAY-1043 attached")
        ?.externalRef,
      "PAY-1043",
    );
  });

  test("returns undefined when no known reference is quoted", () => {
    assert.equal(matchCheckByRef(checks, "Weekly newsletter"), undefined);
    assert.equal(matchCheckByRef(checks, "BGV-9999 unrelated"), undefined);
  });

  test("quarantines a reference duplicated across tenants", () => {
    assert.equal(
      matchCheckByRef(
        [{ externalRef: "BGV-1042" }, { externalRef: "BGV-1042" }],
        "BGV-1042 completed",
      ),
      undefined,
    );
  });

  test("global matching quarantines duplicate references across tenants", () => {
    const tenantChecks = [
      { externalRef: "BGV-1042", organizationId: "org-a", id: 1 },
      { externalRef: "BGV-1042", organizationId: "org-b", id: 2 },
    ];
    assert.equal(
      matchCheckByRef(tenantChecks, "BGV-1042 completed"),
      undefined,
    );
  });

  test("does not match a reference that is only a token prefix", () => {
    assert.equal(
      matchCheckByRef([{ externalRef: "BGV-1001" }], "BGV-10010 completed"),
      undefined,
    );
  });
});

describe("shared-mailbox polling attribution", () => {
  const check = (id: number, organizationId: string, externalRef: string) => ({
    id,
    organizationId,
    caseId: id,
    status: "pending",
    system: "bgv",
    note: null,
    mode: "email",
    externalRef,
    slaDueAt: new Date(),
    lastCheckedAt: null,
    completedAt: null,
    escalatedAt: null,
  });
  const message = (subject: string) => ({
    id: "gmail-1",
    payload: {
      headers: [
        { name: "From", value: "status@vendor.example" },
        { name: "Subject", value: subject },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from("completed").toString("base64url") },
    },
  });

  test("polling path quarantines prefixes and cross-tenant duplicate refs", async () => {
    const applied: string[] = [];
    const deps = {
      fetchDetail: async () => ({
        ok: true,
        json: async () => message("BGV-10010 completed"),
      }),
      alreadyRecorded: async () => false,
      apply: async (opts: { organizationId: string }) => {
        applied.push(opts.organizationId);
        return "applied";
      },
    };
    await processWatchMessageRefs(
      [{ id: "gmail-1" }],
      [check(1, "org-a", "BGV-1001")] as never[],
      deps as never,
    );
    assert.deepEqual(applied, []);

    deps.fetchDetail = async () => ({
      ok: true,
      json: async () => message("BGV-1001 completed"),
    });
    await processWatchMessageRefs(
      [{ id: "gmail-1" }],
      [
        check(1, "org-a", "BGV-1001"),
        check(2, "org-b", "BGV-1001"),
      ] as never[],
      deps as never,
    );
    assert.deepEqual(applied, []);
  });
});

describe("senderTrusted", () => {
  const allow = "status@vendor.com, Vendor-Notifications.example";

  test("exact address match, case-insensitive", () => {
    assert.equal(senderTrusted("Status@Vendor.com", allow), true);
    assert.equal(senderTrusted("other@vendor.com", allow), false);
  });

  test("domain match trusts any sender at that domain", () => {
    assert.equal(senderTrusted("noreply@vendor-notifications.example", allow), true);
    assert.equal(senderTrusted("noreply@evil.example", allow), false);
  });

  test("empty allowlist trusts nobody", () => {
    assert.equal(senderTrusted("status@vendor.com", ""), false);
  });
});
