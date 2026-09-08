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
import customIntentsRouter from "./custom-intents";

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
});