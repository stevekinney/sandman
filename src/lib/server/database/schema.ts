import { sql } from 'drizzle-orm';
import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const DEMO_SESSION_STATUS = {
	Active: 'active',
	Expired: 'expired',
	Revoked: 'revoked'
} as const;

export const SANDBOX_SESSION_STATUS = {
	Provisioning: 'provisioning',
	Bootstrapping: 'bootstrapping',
	Ready: 'ready',
	Error: 'error',
	Expired: 'expired',
	Terminated: 'terminated'
} as const;

export type DemoSessionStatus = (typeof DEMO_SESSION_STATUS)[keyof typeof DEMO_SESSION_STATUS];

export type SandboxSessionStatus =
	(typeof SANDBOX_SESSION_STATUS)[keyof typeof SANDBOX_SESSION_STATUS];

export const demoSession = pgTable('demo_session', {
	id: text('id').primaryKey(),
	tokenHash: text('token_hash').notNull(),
	status: text('status').notNull().default(DEMO_SESSION_STATUS.Active),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow()
});

export const sandboxSession = pgTable(
	'sandbox_session',
	{
		id: text('id').primaryKey(),
		sessionId: text('session_id')
			.notNull()
			.references(() => demoSession.id, { onDelete: 'cascade' }),
		e2bSandboxId: text('e2b_sandbox_id').unique(),
		status: text('status').notNull().default(SANDBOX_SESSION_STATUS.Provisioning),
		errorMessage: text('error_message'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		bootstrappedAt: timestamp('bootstrapped_at', { withTimezone: true }),
		terminatedAt: timestamp('terminated_at', { withTimezone: true }),
		/**
		 * Stamped once this row's E2B VM (if any) is confirmed terminated —
		 * independent of `status`. `status` alone can't carry both "occupies a
		 * capacity slot" and "VM still needs reclaiming": a row must leave the
		 * active-status set immediately on expiry to avoid colliding with
		 * `sandbox_session_active_session_unique`, but its VM may still be
		 * running at that instant. NULL means "not yet reclaimed" (or reclaim
		 * doesn't apply — no VM was ever attached); the reconciler queries on
		 * this column, not on `status`.
		 */
		reclaimedAt: timestamp('reclaimed_at', { withTimezone: true })
	},
	(table) => [
		uniqueIndex('sandbox_session_active_session_unique')
			.on(table.sessionId)
			.where(sql`${table.status} in ('provisioning', 'bootstrapping', 'ready')`)
	]
);

export const rateLimitBucket = pgTable('rate_limit_bucket', {
	key: text('key').primaryKey(),
	windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
	count: integer('count').notNull().default(0),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});
