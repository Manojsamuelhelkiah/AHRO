import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startProduction } from "./start-production.mjs";
import { blockedPublishBackupBlockingCategories } from "./blocked-publish-backup-readiness.mjs";
import { STARTUP_FAILURE_REASONS } from "./verify-tenant-safeguards.mjs";

const backupReady = () => [];

test("production publish startup uses the tenant safeguard gate", async () => {
  const artifactConfig = await readFile(
    new URL("./.replit-artifact/artifact.toml", import.meta.url),
    "utf8",
  );

  assert.match(
    artifactConfig,
    /args = \["node", "--enable-source-maps", "artifacts\/api-server\/start-production\.mjs"\]/,
  );
});

test("starts the API only after tenant safeguards pass", async () => {
  const calls = [];

  await startProduction({
    validateBackupAlertReadiness: backupReady,
    verify: async () => {
      calls.push("verify");
      return { schema: "public", failures: [] };
    },
    startApi: async () => {
      calls.push("start");
    },
    clearBlockedPublishAlert: async () => {
      calls.push("clear-alert");
    },
  });

  assert.deepEqual(calls, ["verify", "clear-alert", "start"]);
});

for (const [settingCategory, privateValue] of [
  ["Backup WhatsApp destination", "whatsapp:555-123-4567"],
  ["Twilio WhatsApp sender", "whatsapp:+01234567890"],
]) {
  test(`blocks API startup when ${settingCategory.toLowerCase()} is malformed`, async () => {
    const calls = [];

    await assert.rejects(
      startProduction({
        validateBackupAlertReadiness: () => [settingCategory],
        verify: async () => {
          calls.push("verify");
          return { schema: "public", failures: [] };
        },
        alertBlockedPublish: async () => {
          calls.push("alert");
        },
        startApi: async () => {
          calls.push("start");
        },
      }),
      (error) => {
        assert.equal(error.code, "PRODUCTION_STARTUP_BLOCKED");
        assert.equal(
          error.reasonCategory,
          STARTUP_FAILURE_REASONS.BACKUP_ALERT_CONFIGURATION,
        );
        assert.match(error.message, new RegExp(settingCategory));
        assert.doesNotMatch(error.message, new RegExp(privateValue));
        assert.doesNotMatch(error.message, /SID|token|credential/i);
        return true;
      },
    );

    assert.deepEqual(calls, []);
  });
}

for (const [settingCategory, configured] of [
  [
    "Backup WhatsApp destination",
    {
      TWILIO_ACCOUNT_SID: "AC-private-account",
      TWILIO_AUTH_TOKEN: "private-auth-token",
      TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
    },
  ],
  [
    "Twilio account configuration",
    {
      ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP: "whatsapp:+15551234567",
      TWILIO_WHATSAPP_FROM: "whatsapp:+14155238886",
    },
  ],
  [
    "Twilio WhatsApp sender",
    {
      ONBOARDING_BLOCKED_PUBLISH_BACKUP_WHATSAPP: "whatsapp:+15551234567",
      TWILIO_ACCOUNT_SID: "AC-private-account",
      TWILIO_AUTH_TOKEN: "private-auth-token",
    },
  ],
]) {
  test(`blocks API startup when required ${settingCategory.toLowerCase()} is missing`, async () => {
    const calls = [];
    await assert.rejects(
      startProduction({
        validateBackupAlertReadiness: () =>
          blockedPublishBackupBlockingCategories(configured),
        verify: async () => {
          calls.push("verify");
          return { schema: "public", failures: [] };
        },
        startApi: async () => calls.push("start"),
      }),
      (error) => {
        assert.equal(
          error.reasonCategory,
          STARTUP_FAILURE_REASONS.BACKUP_ALERT_CONFIGURATION,
        );
        assert.match(error.message, new RegExp(settingCategory));
        assert.doesNotMatch(
          error.message,
          /AC-private-account|private-auth-token|\+15551234567|\+14155238886/,
        );
        return true;
      },
    );
    assert.deepEqual(calls, []);
  });
}

test("explicit backup-channel opt-out allows production startup", async () => {
  const calls = [];
  await startProduction({
    validateBackupAlertReadiness: () =>
      blockedPublishBackupBlockingCategories({
        ONBOARDING_BLOCKED_PUBLISH_BACKUP_REQUIRED: "false",
      }),
    verify: async () => {
      calls.push("verify");
      return { schema: "public", failures: [] };
    },
    clearBlockedPublishAlert: async () => calls.push("clear-alert"),
    startApi: async () => calls.push("start"),
  });
  assert.deepEqual(calls, ["verify", "clear-alert", "start"]);
});

test("blocks API startup when tenant safeguards fail", async () => {
  let started = false;
  let alerts = 0;

  await assert.rejects(
    startProduction({
      validateBackupAlertReadiness: backupReady,
      verify: async () => ({
        schema: "public",
        failures: ["foreign key missing: example"],
      }),
      startApi: async () => {
        started = true;
      },
      alertBlockedPublish: async () => {
        alerts += 1;
      },
    }),
    (error) => {
      assert.equal(
        error.reasonCategory,
        STARTUP_FAILURE_REASONS.SAFEGUARD_MISMATCH,
      );
      assert.match(
        error.message,
        /reason=SAFEGUARD_MISMATCH[\s\S]*Production is not trusted and the API will not start[\s\S]*foreign key missing: example/,
      );
      assert.doesNotMatch(error.message, /schema public/);
      return true;
    },
  );

  assert.equal(started, false);
  assert.equal(alerts, 1);
});

test("blocks API startup when verification cannot run", async () => {
  let started = false;
  let alerts = 0;

  await assert.rejects(
    startProduction({
      validateBackupAlertReadiness: backupReady,
      verify: async () => {
        throw new Error("read-only production connection unavailable");
      },
      startApi: async () => {
        started = true;
      },
      alertBlockedPublish: async () => {
        alerts += 1;
      },
    }),
    /read-only production connection unavailable/,
  );

  assert.equal(started, false);
  assert.equal(alerts, 1);
});

for (const [reasonCategory, timeoutTarget] of [
  [STARTUP_FAILURE_REASONS.CONNECTION_TIMEOUT, "database connection"],
  [STARTUP_FAILURE_REASONS.STATEMENT_TIMEOUT, "database statement"],
]) {
  test(`blocks API startup with reason ${reasonCategory}`, async () => {
    let started = false;
    const verificationError = new Error(
      `tenant safeguard ${timeoutTarget} timed out after 10ms; production is not trusted`,
    );
    verificationError.reasonCategory = reasonCategory;
    let alerts = 0;

    await assert.rejects(
      startProduction({
        validateBackupAlertReadiness: backupReady,
        verify: async () => {
          throw verificationError;
        },
        startApi: async () => {
          started = true;
        },
        alertBlockedPublish: async () => {
          alerts += 1;
        },
      }),
      (error) => {
        assert.equal(error.code, "PRODUCTION_STARTUP_BLOCKED");
        assert.equal(error.reasonCategory, reasonCategory);
        assert.equal(error.cause, verificationError);
        assert.match(error.message, new RegExp(`reason=${reasonCategory}`));
        assert.match(
          error.message,
          /production is not trusted. The API will not start/,
        );
        return true;
      },
    );

    assert.equal(started, false);
    assert.equal(alerts, 1);
  });
}

test("an alert delivery failure never replaces the safeguard failure", async () => {
  await assert.rejects(
    startProduction({
      validateBackupAlertReadiness: backupReady,
      verify: async () => ({
        schema: "public",
        failures: ["tenant safeguard failed"],
      }),
      alertBlockedPublish: async () => {
        throw new Error("mail unavailable");
      },
    }),
    /tenant safeguard failed/,
  );
});

test("a stalled alert cannot delay the original startup failure indefinitely", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    startProduction({
      validateBackupAlertReadiness: backupReady,
      verify: async () => {
        throw new Error("tenant safeguards unavailable");
      },
      alertBlockedPublish: async () => new Promise(() => {}),
      alertTimeoutMs: 10,
    }),
    /tenant safeguards unavailable/,
  );

  assert.ok(Date.now() - startedAt < 250);
});

test("a stalled alert reset cannot delay a verified API startup", async () => {
  let started = false;
  const startedAt = Date.now();
  await startProduction({
    validateBackupAlertReadiness: backupReady,
    verify: async () => ({ schema: "public", failures: [] }),
    clearBlockedPublishAlert: async () => new Promise(() => {}),
    alertTimeoutMs: 10,
    startApi: async () => {
      started = true;
    },
  });

  assert.equal(started, true);
  assert.ok(Date.now() - startedAt < 250);
});

test("the production CLI exits after an alert timeout even with an active handle", () => {
  const script = `
    import { runProductionCli, startProduction } from ${JSON.stringify(
      new URL("./start-production.mjs", import.meta.url).href,
    )};
    await runProductionCli({
      start: () => startProduction({
        validateBackupAlertReadiness: () => [],
        verify: async () => { throw new Error("tenant safeguards unavailable"); },
        alertBlockedPublish: async () => {
          setInterval(() => {}, 1_000);
          return new Promise(() => {});
        },
        alertTimeoutMs: 10,
      }),
    });
  `;
  const startedAt = Date.now();
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 1_000,
  });

  assert.equal(child.signal, null);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Production startup blocked: tenant safeguards unavailable/);
  assert.ok(Date.now() - startedAt < 750);
});
