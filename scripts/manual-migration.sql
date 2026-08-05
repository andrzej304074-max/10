-- ============================================================================
--  Migracja ręczna — do wklejenia w edytorze SQL bazy danych
--  (Vercel → Storage → Twoja baza → Query, albo konsola Neon → SQL Editor)
--
--  Odpowiednik polecenia `npm run db:migrate`, ale bez Node.js i bez
--  klonowania repozytorium. Wklej CAŁOŚĆ i uruchom raz.
--
--  Ostatni blok wpisuje migracje do rejestru Drizzle. Dzięki temu, jeśli
--  kiedyś uruchomisz `npm run db:migrate` z komputera, narzędzie rozpozna,
--  że są już wykonane, i ich nie powtórzy.
--
--  Plik generowany — nie edytuj ręcznie:
--      npm run db:generate && node scripts/build-manual-migration.mjs
-- ============================================================================

-- ---------------------------------------------------------------------------
--  0000_init
-- ---------------------------------------------------------------------------

CREATE TYPE "public"."email_source" AS ENUM('webhook', 'imap', 'manual');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('received', 'skipped', 'parse_failed', 'processed');--> statement-breakpoint
CREATE TYPE "public"."lead_event_status" AS ENUM('pending', 'sent', 'failed_retryable', 'dead');--> statement-breakpoint
CREATE TABLE "dead_letters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"message_id" text,
	"payload" jsonb,
	"error_code" integer,
	"error_body" text,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_note" text
);
--> statement-breakpoint
CREATE TABLE "lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"event_id" text NOT NULL,
	"event_name" text DEFAULT 'Lead' NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"listing_id" text,
	"event_source_url" text,
	"em_hash" text,
	"ph_hash" text,
	"fn_hash" text,
	"ln_hash" text,
	"country_hash" text,
	"payload_snapshot" jsonb,
	"status" "lead_event_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"meta_response_code" integer,
	"meta_response_body" text,
	"meta_fbtrace_id" text,
	"events_received" integer,
	"test_mode" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"source" "email_source" NOT NULL,
	"provider" text,
	"from_masked" text,
	"subject" text,
	"received_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"status" "email_status" DEFAULT 'received' NOT NULL,
	"skip_reason" text,
	"listing_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dead_letters_event_id_key" ON "dead_letters" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "dead_letters_resolved_at_idx" ON "dead_letters" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "dead_letters_created_at_idx" ON "dead_letters" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_event_id_key" ON "lead_events" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_events_message_id_key" ON "lead_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "lead_events_status_idx" ON "lead_events" USING btree ("status","last_attempt_at");--> statement-breakpoint
CREATE INDEX "lead_events_created_at_idx" ON "lead_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processed_emails_message_id_key" ON "processed_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "processed_emails_created_at_idx" ON "processed_emails" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "processed_emails_status_idx" ON "processed_emails" USING btree ("status");

-- ============================================================================
--  Rejestr migracji Drizzle
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS "drizzle";

CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
	id SERIAL PRIMARY KEY,
	hash text NOT NULL,
	created_at bigint
);

INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
SELECT 'c355c2a1dba9aaeb58d4fdd8952b692b99422a212bfc400764ed2ba7ced05884', 1785249294441
WHERE NOT EXISTS (
	SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = 'c355c2a1dba9aaeb58d4fdd8952b692b99422a212bfc400764ed2ba7ced05884'
);
