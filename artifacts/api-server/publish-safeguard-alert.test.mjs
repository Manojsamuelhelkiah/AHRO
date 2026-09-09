import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  alertBlockedPublish,
  blockedPublishAlertMarker,
  claimBlockedPublishAlert,
  clearBlockedPublishAlert,
} from "./publish-safeguard-alert.mjs";

test("claims only the first retry while an alert is active", async () => {
  let active = false;
  const marker = {
    async save() {
      if (active) throw Object.assign(new Error("already exists"), { code: 412 });
      active = true;
    },
  };

  assert.equal(await claimBlockedPublishAlert(marker), true);
  assert.equal(await claimBlockedPublishAlert(marker), false);
});

test(
  "real App Storage grants exactly one simultaneous blocked-publish claim",
  { skip: !process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID },
  async () => {
    const marker = blockedPublishAlertMarker(
      `.system-alerts/integration-tests/blocked-publish-${randomUUID()}`,
    );

    try {
      const claims = await Promise.all([
        claimBlockedPublishAlert(marker),
        claimBlockedPublishAlert(marker),
      ]);
      assert.deepEqual(claims.toSorted(), [false, true]);
    } finally {
      await clearBlockedPublishAlert({ marker });
    }
  },
);

test("sends a generic actionable alert without safeguard details", async () => {
  let request;
  const marker = { save: async () => {} };
  const connectors = {
    async proxy(_connector, _path, options) {
      request = options;
      return { ok: true };
    },
  };

  const result = await alertBlockedPublish({
    operatorEmail: "operator@example.com",
    marker,
    connectors,
  });

  assert.deepEqual(result, { claimed: true, sent: true });
  const message = Buffer.from(
    JSON.parse(request.body).raw,
    "base64url",
  ).toString("utf8");
  assert.match(message, /tenant safeguards could not be trusted/);
  assert.match(message, /Review the deployment logs/);
  assert.doesNotMatch(message, /schema|foreign key|orphan|DATABASE_URL/i);
});

test("suppresses email when another retry already claimed the alert", async () => {
  let sends = 0;
  const result = await alertBlockedPublish({
    operatorEmail: "operator@example.com",
    marker: {
      save: async () => {
        throw Object.assign(new Error("already exists"), { code: 412 });
      },
    },
    connectors: {
      proxy: async () => {
        sends += 1;
        return { ok: true };
      },
    },
  });

  assert.deepEqual(result, { claimed: false, sent: false });
  assert.equal(sends, 0);
});

test("successful verification clears the active retry fence", async () => {
  let deleteOptions;
  await clearBlockedPublishAlert({
    marker: {
      async delete(options) {
        deleteOptions = options;
      },
    },
  });

  assert.deepEqual(deleteOptions, { ignoreNotFound: true });
});

test("a definite delivery rejection releases the claim for a later retry", async () => {
  let deleted = 0;
  await assert.rejects(
    alertBlockedPublish({
      operatorEmail: "operator@example.com",
      marker: {
        save: async () => {},
        delete: async () => {
          deleted += 1;
        },
      },
      connectors: {
        proxy: async () => ({
          ok: false,
          status: 503,
          text: async () => "provider details must not reach startup logs",
        }),
      },
    }),
    /operator email delivery failed \(503\)/,
  );

  assert.equal(deleted, 1);
});

test("a definite Gmail rejection uses the configured backup WhatsApp destination", async () => {
  let deleted = 0;
  let twilioRequest;
  const result = await alertBlockedPublish({
    operatorEmail: "operator@example.com",
    backupWhatsApp: "+15551234567",
    twilioAccountSid: "AC-test",
    twilioAuthToken: "test-token",
    twilioWhatsAppFrom: "+15557654321",
    marker: {
      save: async () => {},
      delete: async () => {
        deleted += 1;
      },
    },
    connectors: {
      proxy: async () => ({
        ok: false,
        status: 503,
        text: async () => "private Gmail response",
      }),
    },
    fetchImpl: async (_url, options) => {
      twilioRequest = options;
      return { ok: true };
    },
  });

  assert.deepEqual(result, { claimed: true, sent: true });
  assert.equal(deleted, 0);
  const message = new URLSearchParams(twilioRequest.body);
  assert.equal(message.get("To"), "whatsapp:+15551234567");
  assert.match(message.get("Body"), /tenant safeguards could not be trusted/);
  assert.doesNotMatch(message.get("Body"), /schema|foreign key|orphan|DATABASE_URL/i);
});

test("an ambiguous Gmail request never sends the backup channel", async () => {
  let backupSends = 0;
  let deleted = 0;
  await assert.rejects(
    alertBlockedPublish({
      operatorEmail: "operator@example.com",
      backupWhatsApp: "+15551234567",
      twilioAccountSid: "AC-test",
      twilioAuthToken: "test-token",
      twilioWhatsAppFrom: "+15557654321",
      marker: {
        save: async () => {},
        delete: async () => {
          deleted += 1;
        },
      },
      connectors: {
        proxy: async () => {
          throw new Error("connection reset");
        },
      },
      fetchImpl: async () => {
        backupSends += 1;
        return { ok: true };
      },
    }),
    /connection reset/,
  );
  assert.equal(backupSends, 0);
  assert.equal(deleted, 0);
});

test("an ambiguous backup request retains the claim to prevent duplicate alerts", async () => {
  let deleted = 0;
  await assert.rejects(
    alertBlockedPublish({
      operatorEmail: "operator@example.com",
      backupWhatsApp: "+15551234567",
      twilioAccountSid: "AC-test",
      twilioAuthToken: "test-token",
      twilioWhatsAppFrom: "+15557654321",
      marker: {
        save: async () => {},
        delete: async () => {
          deleted += 1;
        },
      },
      connectors: {
        proxy: async () => ({
          ok: false,
          status: 503,
          text: async () => "private Gmail response",
        }),
      },
      fetchImpl: async () => {
        throw new Error("Twilio connection reset");
      },
    }),
    /Twilio connection reset/,
  );
  assert.equal(deleted, 0);
});

test("missing backup credentials release the claim so corrected configuration can retry", async () => {
  let active = false;
  let backupSends = 0;
  const marker = {
    async save() {
      if (active) throw Object.assign(new Error("already exists"), { code: 412 });
      active = true;
    },
    async delete() {
      active = false;
    },
  };
  const connectors = {
    proxy: async () => ({
      ok: false,
      status: 503,
      text: async () => "private Gmail response",
    }),
  };

  await assert.rejects(
    alertBlockedPublish({
      operatorEmail: "operator@example.com",
      backupWhatsApp: "+15551234567",
      twilioAccountSid: "",
      twilioAuthToken: "",
      twilioWhatsAppFrom: "",
      marker,
      connectors,
    }),
    /configured without Twilio credentials/,
  );
  assert.equal(active, false);

  const result = await alertBlockedPublish({
    operatorEmail: "operator@example.com",
    backupWhatsApp: "+15551234567",
    twilioAccountSid: "AC-test",
    twilioAuthToken: "test-token",
    twilioWhatsAppFrom: "+15557654321",
    marker,
    connectors,
    fetchImpl: async () => {
      backupSends += 1;
      return { ok: true };
    },
  });
  assert.deepEqual(result, { claimed: true, sent: true });
  assert.equal(backupSends, 1);
});

test("definite rejection by both providers releases the claim", async () => {
  let deleted = 0;
  await assert.rejects(
    alertBlockedPublish({
      operatorEmail: "operator@example.com",
      backupWhatsApp: "+15551234567",
      twilioAccountSid: "AC-test",
      twilioAuthToken: "test-token",
      twilioWhatsAppFrom: "+15557654321",
      marker: {
        save: async () => {},
        delete: async () => {
          deleted += 1;
        },
      },
      connectors: {
        proxy: async () => ({
          ok: false,
          status: 503,
          text: async () => "private Gmail response",
        }),
      },
      fetchImpl: async () => ({
        ok: false,
        status: 503,
        text: async () => "private Twilio response",
      }),
    }),
    /backup WhatsApp delivery failed \(503\)/,
  );
  assert.equal(deleted, 1);
});