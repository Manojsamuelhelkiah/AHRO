ALTER TABLE "offb_exchanges" ADD COLUMN "attempted_at" timestamp with time zone;
--> statement-breakpoint
CREATE UNIQUE INDEX offb_exchange_outbound_reference ON offb_exchanges(reference) WHERE direction = 'outbound';
