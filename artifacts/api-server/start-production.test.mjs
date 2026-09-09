import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { startProduction } from "./start-production.mjs";

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
  });

  assert.deepEqual(calls, ["verify", "start"]);
});

test("blocks API startup when tenant safeguards fail", async () => {
  let started = false;

  await assert.rejects(
    startProduction({
      verify: async () => ({
        schema: "public",
        failures: ["foreign key missing: example"],
      }),
      startApi: async () => {
        started = true;
      },
    }),
    /Production is not trusted and the API will not start[\s\S]*foreign key missing: example/,
  );

  assert.equal(started, false);
});

test("blocks API startup when verification cannot run", async () => {
  let started = false;

  await assert.rejects(
    startProduction({
      verify: async () => {
        throw new Error("read-only production connection unavailable");
      },
      startApi: async () => {
        started = true;
      },
    }),
    /read-only production connection unavailable/,
  );

  assert.equal(started, false);
});

test("blocks API startup with a clear trust decision after verification timeout", async () => {
  let started = false;

  await assert.rejects(
    startProduction({
      verify: async () => {
        throw new Error(
          "tenant safeguard database connection timed out after 10ms; production is not trusted",
        );
      },
      startApi: async () => {
        started = true;
      },
    }),
    /timed out after 10ms; production is not trusted/,
  );

  assert.equal(started, false);
});