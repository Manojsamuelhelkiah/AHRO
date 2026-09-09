import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startProduction } from "./start-production.mjs";
import { STARTUP_FAILURE_REASONS } from "./verify-tenant-safeguards.mjs";

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

test("blocks API startup when tenant safeguards fail", async () => {
  let started = false;
  let alerts = 0;

  await assert.rejects(
    startProduction({
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
