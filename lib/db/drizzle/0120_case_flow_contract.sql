CREATE TABLE "case_flow_definitions" (
  "id" text NOT NULL,
  "version" integer NOT NULL,
  "family" text NOT NULL,
  "digest" text NOT NULL,
  "definition" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("id", "version"),
  CONSTRAINT "case_flow_definition_version" CHECK ("version" > 0),
  CONSTRAINT "case_flow_definition_family" CHECK ("family" IN ('onboarding', 'separation'))
);
--> statement-breakpoint
CREATE TABLE "case_flow_bindings" (
  "organization_id" text NOT NULL,
  "case_id" integer NOT NULL,
  "definition_id" text,
  "definition_version" integer,
  "compatibility" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "case_id"),
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "onb_cases" ("organization_id", "id") ON DELETE CASCADE,
  FOREIGN KEY ("definition_id", "definition_version") REFERENCES "case_flow_definitions" ("id", "version"),
  CONSTRAINT "case_flow_binding_compatibility" CHECK ("compatibility" IN ('bound', 'review-required', 'review-only')),
  CONSTRAINT "case_flow_binding_identity" CHECK (("definition_id" IS NULL) = ("definition_version" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "case_flow_transitions" (
  "organization_id" text NOT NULL,
  "case_id" integer NOT NULL,
  "operation_key" text NOT NULL,
  "definition_id" text NOT NULL,
  "definition_version" integer NOT NULL,
  "action_id" text NOT NULL,
  "domain_version" integer NOT NULL,
  "generation" integer NOT NULL,
  "outcome" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "case_id", "operation_key"),
  FOREIGN KEY ("organization_id", "case_id") REFERENCES "case_flow_bindings" ("organization_id", "case_id") ON DELETE CASCADE,
  FOREIGN KEY ("definition_id", "definition_version") REFERENCES "case_flow_definitions" ("id", "version"),
  CONSTRAINT "case_flow_transition_outcome" CHECK ("outcome" IN ('validated', 'recorded', 'held'))
);
--> statement-breakpoint
CREATE INDEX "case_flow_transition_history" ON "case_flow_transitions" ("organization_id", "case_id", "created_at");
--> statement-breakpoint
-- No source facts, effects or approval records are copied or modified. Existing
-- records start under explicit compatibility review; executable identities are
-- registered and confidently mapped by the deterministic application reconciler.
INSERT INTO "case_flow_bindings" ("organization_id", "case_id", "compatibility", "reason")
SELECT "organization_id", "id",
  CASE WHEN "hire_type" = 'service-request' THEN 'review-only' ELSE 'review-required' END,
  'Legacy record requires deterministic compatibility assessment; no execution authority was granted.'
FROM "onb_cases";
--> statement-breakpoint
CREATE FUNCTION "case_flow_reject_definition_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Executable base-flow definitions are immutable; register a new version';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "case_flow_definitions_immutable"
BEFORE UPDATE OR DELETE OR TRUNCATE ON "case_flow_definitions"
FOR EACH STATEMENT EXECUTE FUNCTION "case_flow_reject_definition_mutation"();
--> statement-breakpoint
CREATE FUNCTION "case_flow_preserve_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.case_id IS DISTINCT FROM NEW.case_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR OLD.definition_id IS NOT NULL
    OR OLD.definition_version IS NOT NULL
    OR OLD.compatibility <> 'review-required'
    OR NEW.compatibility <> 'bound'
    OR NEW.definition_id IS NULL
    OR NEW.definition_version IS NULL THEN
    RAISE EXCEPTION 'Case executable binding cannot be replaced or migrated to another version';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "case_flow_binding_immutable"
BEFORE UPDATE ON "case_flow_bindings"
FOR EACH ROW EXECUTE FUNCTION "case_flow_preserve_binding"();
