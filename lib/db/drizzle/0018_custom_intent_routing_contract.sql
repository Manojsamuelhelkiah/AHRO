ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "registry_version" text DEFAULT 'research-v1' NOT NULL;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "parent_intent_key" text;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "exact_aliases" text DEFAULT '[]' NOT NULL;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "accountable_specialist" text DEFAULT 'HRO Service Owner' NOT NULL;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "risk_class" text DEFAULT 'medium' NOT NULL;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "action_schema" text DEFAULT '{"actions":[{"type":"intake","name":"capture-client-request","description":"Capture the approved client-specific request for specialist triage.","inputSchema":{"type":"object","required":["requestId","subjectId"]},"executorKey":null}]}' NOT NULL;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "evidence_contract" text DEFAULT '{"required":["request","actor","recordedAt"]}' NOT NULL;
ALTER TABLE "custom_intents" ADD COLUMN IF NOT EXISTS "maturity" text DEFAULT 'catalogued' NOT NULL;

CREATE TABLE IF NOT EXISTS "custom_intent_routing_labels" (
  "label" text PRIMARY KEY NOT NULL,
  "custom_intent_id" integer NOT NULL REFERENCES "custom_intents"("id") ON DELETE CASCADE,
  "registry_version" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

INSERT INTO "custom_intent_routing_labels" ("label", "custom_intent_id", "registry_version")
SELECT "key", "id", "registry_version"
FROM "custom_intents"
ON CONFLICT ("label") DO NOTHING;

INSERT INTO "custom_intent_routing_labels" ("label", "custom_intent_id", "registry_version")
SELECT alias.value, intent.id, intent.registry_version
FROM "custom_intents" intent
CROSS JOIN LATERAL jsonb_array_elements_text(intent.exact_aliases::jsonb) alias(value)
ON CONFLICT ("label") DO NOTHING;