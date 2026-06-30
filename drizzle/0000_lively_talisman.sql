CREATE TABLE "demo_session" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_bucket" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_session" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"e2b_sandbox_id" text NOT NULL,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"bootstrapped_at" timestamp with time zone,
	"terminated_at" timestamp with time zone,
	CONSTRAINT "sandbox_session_e2b_sandbox_id_unique" UNIQUE("e2b_sandbox_id")
);
--> statement-breakpoint
ALTER TABLE "sandbox_session" ADD CONSTRAINT "sandbox_session_session_id_demo_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."demo_session"("id") ON DELETE cascade ON UPDATE no action;