import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  customIntentRoutingLabelsTable,
  customIntentsTable,
  db,
  pool,
} from "@workspace/db";
import { errorHandler } from "../middlewares/error-handler";
import customIntentsRouter, {
  setCustomIntentCreateAfterPreflightHookForTests,
} from "./custom-intents";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("custom intent concurrent routing updates", { skip: !hasDb }, () => {
  const app = express();
  app.use(express.json());
  app.use(customIntentsRouter);
  app.use(errorHandler);

  const server = createServer(app);
  let baseUrl = "";

  before(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await pool.end();
  });

  test("overlapping PATCHes keep aliases reserved and reject an invalid owner/executor merge", async (t) => {
    const schemaCheck = await pool.query<{ ready: boolean }>(`
      select (
        to_regclass('custom_intent_routing_labels') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'custom_intents'
            and column_name = 'registry_version'
        )
      ) as ready
    `);
    if (!schemaCheck.rows[0]?.ready) {
      t.skip("custom intent routing schema has not been applied to this database");
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const key = `concurrent-routing-${suffix}`;
    const oldAlias = `concurrent_old_${suffix}`;
    const newAlias = `concurrent_new_${suffix}`;
    const [created] = await db
      .insert(customIntentsTable)
      .values({
        key,
        name: "Concurrent routing regression",
        domain: "hire",
        flowClass: "fc2-policy",
        description: "Initial description",
        asIsHandlingMin: 10,
        toBeHumanMin: 2,
        baseWeight: 1,
        actGetActions: 1,
        actPutActions: 0,
        systemsTouchedBase: 1,
        tags: '["custom"]',
        source: "integration-test",
        author: "integration-test",
        exactAliases: JSON.stringify([oldAlias]),
        accountableSpecialist: "Onboarding Coordinator",
        actionSchema: JSON.stringify({
          actions: [{
            type: "intake",
            name: "capture-request",
            description: "Capture the request.",
            inputSchema: { type: "object" },
            executorKey: null,
          }],
        }),
      })
      .returning({ id: customIntentsTable.id });
    assert.ok(created);
    await db.insert(customIntentRoutingLabelsTable).values([
      { label: key, customIntentId: created.id, registryVersion: "research-v1" },
      { label: oldAlias, customIntentId: created.id, registryVersion: "research-v1" },
    ]);

    const patch = (body: Record<string, unknown>) => fetch(
      `${baseUrl}/custom-intents/${key}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    try {
      const [aliasesResponse, ownerResponse, actionResponse] = await Promise.all([
        patch({ exactAliases: [newAlias] }),
        patch({ accountableSpecialist: "BGV Specialist" }),
        patch({
          actionSchema: {
            actions: [{
              type: "workflow",
              name: "run-onboarding",
              description: "Run the onboarding workflow.",
              inputSchema: { type: "object" },
              executorKey: "onboarding-case-workflow",
            }],
          },
          maturity: "simulated",
        }),
      ]);

      assert.equal(aliasesResponse.status, 200);
      const ownerActionStatuses = [ownerResponse.status, actionResponse.status].sort();
      assert.deepEqual(ownerActionStatuses, [200, 400]);

      const [stored] = await db
        .select()
        .from(customIntentsTable)
        .where(eq(customIntentsTable.id, created.id));
      assert.ok(stored);
      assert.deepEqual(JSON.parse(stored.exactAliases), [newAlias]);

      const labels = await db
        .select({ label: customIntentRoutingLabelsTable.label })
        .from(customIntentRoutingLabelsTable)
        .where(eq(customIntentRoutingLabelsTable.customIntentId, created.id));
      assert.deepEqual(
        labels.map(({ label }) => label).sort(),
        [key, newAlias].sort(),
      );

      const actionSchema = JSON.parse(stored.actionSchema) as {
        actions: Array<{ executorKey: string | null }>;
      };
      const executorKey = actionSchema.actions[0]?.executorKey;
      assert.ok(
        (stored.accountableSpecialist === "BGV Specialist" && executorKey === null)
          || (
            stored.accountableSpecialist === "Onboarding Coordinator"
            && executorKey === "onboarding-case-workflow"
          ),
        "the serialized winner must leave a valid owner/executor contract",
      );
    } finally {
      await db.delete(customIntentsTable).where(eq(customIntentsTable.id, created.id));
    }
  });

  test("overlapping POSTs reserve an exact alias for only one custom intent", async (t) => {
    const schemaCheck = await pool.query<{ ready: boolean }>(`
      select (
        to_regclass('custom_intent_routing_labels') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'custom_intents'
            and column_name = 'registry_version'
        )
      ) as ready
    `);
    if (!schemaCheck.rows[0]?.ready) {
      t.skip("custom intent routing schema has not been applied to this database");
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const alias = `concurrent_create_alias_${suffix}`;
    const names = [
      `Concurrent create alpha ${suffix}`,
      `Concurrent create beta ${suffix}`,
    ];
    const keys = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    const payload = (name: string) => ({
      name,
      domain: "hire",
      flowClass: "fc2-policy",
      description: "Concurrent create routing-label regression",
      asIsHandlingMin: 10,
      toBeHumanMin: 2,
      baseWeight: 1,
      actGetActions: 1,
      actPutActions: 0,
      systemsTouchedBase: 1,
      source: "integration-test",
      author: "integration-test",
      exactAliases: [alias],
    });
    const create = (name: string) => fetch(`${baseUrl}/custom-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(name)),
    });
    let preflightCount = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsReached = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    setCustomIntentCreateAfterPreflightHookForTests(async () => {
      preflightCount += 1;
      if (preflightCount === 2) releasePreflights?.();
      await bothPreflightsReached;
    });

    try {
      const responses = await Promise.all(names.map(create));
      const statuses = responses.map(({ status }) => status).sort();
      assert.deepEqual(statuses, [201, 400]);

      const winnerResponse = responses.find(({ status }) => status === 201);
      const loserResponse = responses.find(({ status }) => status === 400);
      assert.ok(winnerResponse);
      assert.ok(loserResponse);
      const winner = await winnerResponse.json() as {
        id: number;
        key: string;
        registryVersion: string;
        exactAliases: string[];
      };
      assert.deepEqual(
        await loserResponse.json(),
        { error: "A canonical key or exact alias already belongs to another outcome" },
      );

      const storedRows = await Promise.all(keys.map(async (key) => {
        const [row] = await db
          .select()
          .from(customIntentsTable)
          .where(eq(customIntentsTable.key, key));
        return row;
      }));
      assert.equal(storedRows.filter(Boolean).length, 1, "the losing custom-intent row must roll back");
      const storedWinner = storedRows.find(Boolean);
      assert.ok(storedWinner);
      assert.equal(storedWinner.id, winner.id);
      assert.equal(storedWinner.key, winner.key);
      assert.equal(storedWinner.registryVersion, winner.registryVersion);
      assert.deepEqual(JSON.parse(storedWinner.exactAliases), winner.exactAliases);

      const reservations = await db
        .select({
          label: customIntentRoutingLabelsTable.label,
          registryVersion: customIntentRoutingLabelsTable.registryVersion,
        })
        .from(customIntentRoutingLabelsTable)
        .where(eq(customIntentRoutingLabelsTable.customIntentId, winner.id));
      assert.deepEqual(
        reservations
          .map(({ label, registryVersion }) => ({ label, registryVersion }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        [winner.key, ...winner.exactAliases]
          .map((label) => ({ label, registryVersion: winner.registryVersion }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
    } finally {
      setCustomIntentCreateAfterPreflightHookForTests(undefined);
      await Promise.all(keys.map((key) =>
        db.delete(customIntentsTable).where(eq(customIntentsTable.key, key))
      ));
    }
  });

  test("overlapping POSTs cannot swap canonical keys and exact aliases", async (t) => {
    const schemaCheck = await pool.query<{ ready: boolean }>(`
      select (
        to_regclass('custom_intent_routing_labels') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'custom_intents'
            and column_name = 'registry_version'
        )
      ) as ready
    `);
    if (!schemaCheck.rows[0]?.ready) {
      t.skip("custom intent routing schema has not been applied to this database");
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const names = [
      `Canonical alias swap alpha ${suffix}`,
      `Canonical alias swap beta ${suffix}`,
    ];
    const keys = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    const payload = (index: number) => ({
      name: names[index],
      domain: "hire",
      flowClass: "fc2-policy",
      description: "Concurrent canonical-key and exact-alias swap regression",
      asIsHandlingMin: 10,
      toBeHumanMin: 2,
      baseWeight: 1,
      actGetActions: 1,
      actPutActions: 0,
      systemsTouchedBase: 1,
      source: "integration-test",
      author: "integration-test",
      exactAliases: [keys[index === 0 ? 1 : 0]],
    });
    const create = (index: number) => fetch(`${baseUrl}/custom-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(index)),
    });
    let preflightCount = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsReached = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    setCustomIntentCreateAfterPreflightHookForTests(async () => {
      preflightCount += 1;
      if (preflightCount === 2) releasePreflights?.();
      await bothPreflightsReached;
    });

    try {
      const responses = await Promise.all([create(0), create(1)]);
      assert.deepEqual(
        responses.map(({ status }) => status).sort(),
        [201, 400],
      );

      const winnerResponse = responses.find(({ status }) => status === 201);
      const loserResponse = responses.find(({ status }) => status === 400);
      assert.ok(winnerResponse);
      assert.ok(loserResponse);
      const winner = await winnerResponse.json() as {
        id: number;
        key: string;
        registryVersion: string;
        exactAliases: string[];
      };
      assert.deepEqual(
        await loserResponse.json(),
        { error: "A canonical key or exact alias already belongs to another outcome" },
      );

      const storedRows = await db
        .select()
        .from(customIntentsTable)
        .where(eq(customIntentsTable.source, "integration-test"));
      const raceRows = storedRows.filter(({ key }) => keys.includes(key));
      assert.equal(raceRows.length, 1, "the losing custom-intent row must roll back");
      const [storedWinner] = raceRows;
      assert.ok(storedWinner);
      assert.equal(storedWinner.id, winner.id);
      assert.equal(storedWinner.key, winner.key);
      assert.equal(storedWinner.registryVersion, winner.registryVersion);
      assert.deepEqual(JSON.parse(storedWinner.exactAliases), winner.exactAliases);

      const reservations = await db
        .select({
          label: customIntentRoutingLabelsTable.label,
          registryVersion: customIntentRoutingLabelsTable.registryVersion,
        })
        .from(customIntentRoutingLabelsTable)
        .where(eq(customIntentRoutingLabelsTable.customIntentId, winner.id));
      assert.deepEqual(
        reservations
          .map(({ label, registryVersion }) => ({ label, registryVersion }))
          .sort((a, b) => a.label.localeCompare(b.label)),
        [winner.key, ...winner.exactAliases]
          .map((label) => ({ label, registryVersion: winner.registryVersion }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
    } finally {
      setCustomIntentCreateAfterPreflightHookForTests(undefined);
      await Promise.all(keys.map((key) =>
        db.delete(customIntentsTable).where(eq(customIntentsTable.key, key))
      ));
    }
  });

  test("overlapping same-name POSTs leave only the winning intent and its labels", async (t) => {
    const schemaCheck = await pool.query<{ ready: boolean }>(`
      select (
        to_regclass('custom_intent_routing_labels') is not null
        and exists (
          select 1
          from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'custom_intents'
            and column_name = 'registry_version'
        )
      ) as ready
    `);
    if (!schemaCheck.rows[0]?.ready) {
      t.skip("custom intent routing schema has not been applied to this database");
      return;
    }

    const suffix = `${process.pid}-${Date.now()}`;
    const name = `Concurrent same name ${suffix}`;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const aliases = [
      `concurrent_same_name_alpha_${suffix}`,
      `concurrent_same_name_beta_${suffix}`,
    ];
    const payload = (alias: string) => ({
      name,
      domain: "hire",
      flowClass: "fc2-policy",
      description: "Concurrent same-name canonical-key regression",
      asIsHandlingMin: 10,
      toBeHumanMin: 2,
      baseWeight: 1,
      actGetActions: 1,
      actPutActions: 0,
      systemsTouchedBase: 1,
      source: "integration-test",
      author: "integration-test",
      exactAliases: [alias],
    });
    const create = (alias: string) => fetch(`${baseUrl}/custom-intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(alias)),
    });
    let preflightCount = 0;
    let releasePreflights: (() => void) | undefined;
    const bothPreflightsReached = new Promise<void>((resolve) => {
      releasePreflights = resolve;
    });
    setCustomIntentCreateAfterPreflightHookForTests(async () => {
      preflightCount += 1;
      if (preflightCount === 2) releasePreflights?.();
      await bothPreflightsReached;
    });

    try {
      const responses = await Promise.all(aliases.map(create));
      assert.deepEqual(responses.map(({ status }) => status).sort(), [201, 400]);

      const winnerIndex = responses.findIndex(({ status }) => status === 201);
      const loserIndex = responses.findIndex(({ status }) => status === 400);
      assert.notEqual(winnerIndex, -1);
      assert.notEqual(loserIndex, -1);
      const winner = await responses[winnerIndex]!.json() as {
        id: number;
        key: string;
        exactAliases: string[];
      };
      assert.deepEqual(
        await responses[loserIndex]!.json(),
        { error: "A canonical key or exact alias already belongs to another outcome" },
      );
      assert.equal(winner.key, key);
      assert.deepEqual(winner.exactAliases, [aliases[winnerIndex]]);

      const storedRows = await db
        .select()
        .from(customIntentsTable)
        .where(eq(customIntentsTable.key, key));
      assert.equal(storedRows.length, 1, "the losing parent row must fully roll back");
      assert.equal(storedRows[0]!.id, winner.id);

      const reservations = await db
        .select({ label: customIntentRoutingLabelsTable.label })
        .from(customIntentRoutingLabelsTable)
        .where(eq(customIntentRoutingLabelsTable.customIntentId, winner.id));
      assert.deepEqual(
        reservations.map(({ label }) => label).sort(),
        [key, aliases[winnerIndex]!].sort(),
      );

      const [losingReservation] = await db
        .select({ customIntentId: customIntentRoutingLabelsTable.customIntentId })
        .from(customIntentRoutingLabelsTable)
        .where(eq(customIntentRoutingLabelsTable.label, aliases[loserIndex]!));
      assert.equal(losingReservation, undefined, "the losing alias reservation must roll back");
    } finally {
      setCustomIntentCreateAfterPreflightHookForTests(undefined);
      await db.delete(customIntentsTable).where(eq(customIntentsTable.key, key));
    }
  });
});
