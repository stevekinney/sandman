ALTER TABLE "sandbox_session" ALTER COLUMN "e2b_sandbox_id" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "sandbox_session_active_session_unique"
ON "sandbox_session" ("session_id")
WHERE "status" in ('provisioning', 'bootstrapping', 'ready');
