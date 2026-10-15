CREATE TABLE offb_exchange_pilots (
  case_id integer PRIMARY KEY,
  organization_id text NOT NULL,
  provenance text NOT NULL,
  scenario text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  generation integer NOT NULL DEFAULT 1,
  state jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offb_exchange_pilot_tenant_fk FOREIGN KEY (organization_id, case_id) REFERENCES offb_cases(organization_id,id) ON DELETE RESTRICT,
  CONSTRAINT offb_exchange_pilot_demo_only CHECK (organization_id = 'demo' AND provenance = 'offboarding-contextual/v1' AND scenario IN ('success','delayed','exception'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX offb_exchange_pilot_tenant_case ON offb_exchange_pilots(organization_id,case_id);
--> statement-breakpoint
CREATE UNIQUE INDEX offb_exchange_pilot_scenario ON offb_exchange_pilots(organization_id,scenario);
--> statement-breakpoint
CREATE TABLE offb_exchanges (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  case_id integer NOT NULL,
  task_id text NOT NULL,
  generation integer NOT NULL,
  task_revision integer NOT NULL,
  enrollment_revision integer NOT NULL,
  reference text NOT NULL,
  direction text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  recipient text NOT NULL,
  member_id text NOT NULL,
  operator text NOT NULL,
  agent_id text NOT NULL,
  persona text NOT NULL,
  mailbox text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  provider_message_id text,
  provider_thread_id text,
  reply_to_id text,
  observation jsonb,
  source_transport_verified integer NOT NULL DEFAULT 0,
  applied integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT offb_exchange_tenant_fk FOREIGN KEY (organization_id,case_id) REFERENCES offb_exchange_pilots(organization_id,case_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX offb_exchange_reference ON offb_exchanges(reference,direction,id);
--> statement-breakpoint
CREATE UNIQUE INDEX offb_exchange_provider_message ON offb_exchanges(provider_message_id);
