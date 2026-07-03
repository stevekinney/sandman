import { and, count, desc, eq, gt, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from './connection.ts';
import {
	DEMO_SESSION_STATUS,
	SANDBOX_SESSION_STATUS,
	demoSession,
	rateLimitBucket,
	sandboxSession,
	type SandboxSessionStatus
} from './schema.ts';

export type SandboxStatusRecord = {
	sandboxId: string;
	status: SandboxSessionStatus;
	errorMessage: string | null;
	expiresAt: Date;
	updatedAt: Date;
};

export type MonitoringSnapshot = {
	activeSandboxes: number;
	globalLimit: number;
	recentBootstrapFailures: number;
	expiredSandboxes: number;
};

export type DemoSessionRecord = {
	id: string;
	tokenHash: string;
};

export type SandboxReservationResult =
	| { status: 'reserved'; reservationId: string }
	| { status: 'session-limit' | 'global-limit' };

type TouchSandboxSessionDatabase = {
	update(table: typeof sandboxSession): {
		set(values: { expiresAt: Date; updatedAt: Date }): {
			where(condition: unknown): {
				returning(fields: { id: typeof sandboxSession.id }): Promise<Array<{ id: string }>>;
			};
		};
	};
};

const ACTIVE_SANDBOX_STATUSES = [
	SANDBOX_SESSION_STATUS.Provisioning,
	SANDBOX_SESSION_STATUS.Bootstrapping,
	SANDBOX_SESSION_STATUS.Ready
] as const;

export async function createDemoSession(
	database: Database,
	input: { sessionId: string; tokenHash: string; now: Date }
): Promise<void> {
	await database.insert(demoSession).values({
		id: input.sessionId,
		tokenHash: input.tokenHash,
		status: DEMO_SESSION_STATUS.Active,
		createdAt: input.now,
		lastSeenAt: input.now
	});
}

export async function touchActiveDemoSession(
	database: Database,
	input: { sessionId: string; now: Date }
): Promise<boolean> {
	const rows = await database
		.update(demoSession)
		.set({ lastSeenAt: input.now })
		.where(
			and(eq(demoSession.id, input.sessionId), eq(demoSession.status, DEMO_SESSION_STATUS.Active))
		)
		.returning({ id: demoSession.id });
	return rows.length === 1;
}

export async function getActiveDemoSession(
	database: Database,
	input: { sessionId: string }
): Promise<DemoSessionRecord | null> {
	const rows = await database
		.select({ id: demoSession.id, tokenHash: demoSession.tokenHash })
		.from(demoSession)
		.where(
			and(eq(demoSession.id, input.sessionId), eq(demoSession.status, DEMO_SESSION_STATUS.Active))
		)
		.limit(1);
	return rows[0] ?? null;
}

export async function createSandboxSession(
	database: Database,
	input: {
		sessionId: string;
		sandboxId: string;
		now: Date;
		expiresAt: Date;
	}
): Promise<void> {
	await database.insert(sandboxSession).values({
		id: crypto.randomUUID(),
		sessionId: input.sessionId,
		e2bSandboxId: input.sandboxId,
		status: SANDBOX_SESSION_STATUS.Provisioning,
		createdAt: input.now,
		updatedAt: input.now,
		expiresAt: input.expiresAt
	});
}

export async function reserveSandboxSlot(
	database: Database,
	input: {
		sessionId: string;
		now: Date;
		expiresAt: Date;
		globalLimit: number;
		perSessionLimit: number;
	}
): Promise<SandboxReservationResult> {
	const reservationId = crypto.randomUUID();
	const rows = await database.execute<{
		status: 'reserved' | 'session-limit' | 'global-limit';
		reservation_id: string | null;
	}>(sql`
		with locked as (
			select pg_advisory_xact_lock(hashtext('sandman:sandbox-capacity'))
		),
		expired as (
			update ${sandboxSession}
			set
				status = ${SANDBOX_SESSION_STATUS.Expired},
				updated_at = ${input.now},
				terminated_at = ${input.now}
			where
				expires_at < ${input.now}
				and status in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})
			returning id
		),
		session_active as (
			select count(*)::int as value
			from ${sandboxSession}, locked
			where
				session_id = ${input.sessionId}
				and expires_at >= ${input.now}
				and status in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})
		),
		global_active as (
			select count(*)::int as value
			from ${sandboxSession}, locked
			where
				expires_at >= ${input.now}
				and status in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})
		),
		inserted as (
			insert into ${sandboxSession} (
				id,
				session_id,
				e2b_sandbox_id,
				status,
				created_at,
				updated_at,
				expires_at
			)
			select
				${reservationId},
				${input.sessionId},
				null,
				${SANDBOX_SESSION_STATUS.Provisioning},
				${input.now},
				${input.now},
				${input.expiresAt}
			from session_active, global_active
			where
				session_active.value < ${input.perSessionLimit}
				and global_active.value < ${input.globalLimit}
			returning id
		)
		select
			case
				when exists(select 1 from inserted) then 'reserved'
				when (select value from session_active) >= ${input.perSessionLimit} then 'session-limit'
				else 'global-limit'
			end as status,
			(select id from inserted) as reservation_id
	`);
	const row = rows.rows[0];
	if (!row) return { status: 'global-limit' };
	if (row.status === 'reserved' && row.reservation_id) {
		return { status: 'reserved', reservationId: row.reservation_id };
	}
	if (row.status === 'session-limit') return { status: 'session-limit' };
	return { status: 'global-limit' };
}

export async function attachSandboxToReservation(
	database: Database,
	input: { reservationId: string; sandboxId: string; now: Date }
): Promise<void> {
	await database
		.update(sandboxSession)
		.set({
			e2bSandboxId: input.sandboxId,
			updatedAt: input.now
		})
		.where(eq(sandboxSession.id, input.reservationId));
}

export async function markSandboxReservationError(
	database: Database,
	input: { reservationId: string; now: Date; errorMessage: string }
): Promise<void> {
	await database
		.update(sandboxSession)
		.set({
			status: SANDBOX_SESSION_STATUS.Error,
			updatedAt: input.now,
			errorMessage: input.errorMessage
		})
		.where(eq(sandboxSession.id, input.reservationId));
}

export async function updateSandboxStatus(
	database: Database,
	input: {
		sandboxId: string;
		status: SandboxSessionStatus;
		now: Date;
		errorMessage?: string;
		expiresAt?: Date;
	}
): Promise<void> {
	await database
		.update(sandboxSession)
		.set({
			status: input.status,
			updatedAt: input.now,
			errorMessage: input.errorMessage,
			expiresAt: input.expiresAt,
			bootstrappedAt: input.status === SANDBOX_SESSION_STATUS.Ready ? input.now : undefined,
			terminatedAt:
				input.status === SANDBOX_SESSION_STATUS.Terminated ||
				input.status === SANDBOX_SESSION_STATUS.Expired
					? input.now
					: undefined
		})
		.where(eq(sandboxSession.e2bSandboxId, input.sandboxId));
}

/**
 * Slides a sandbox session's expiry forward by `ttlMs` from `now` — the
 * idle-based (sliding) counterpart to the fixed `expiresAt` set at creation.
 * Only touches rows still in an active status, so an already-expired or
 * terminated sandbox cannot be revived by a late-arriving mutation.
 */
export async function touchSandboxSession(
	database: TouchSandboxSessionDatabase,
	input: { sandboxId: string; now: Date; ttlMs: number }
): Promise<boolean> {
	const rows = await database
		.update(sandboxSession)
		.set({
			expiresAt: new Date(input.now.getTime() + input.ttlMs),
			updatedAt: input.now
		})
		.where(
			and(
				eq(sandboxSession.e2bSandboxId, input.sandboxId),
				gt(sandboxSession.expiresAt, input.now),
				inArray(sandboxSession.status, ACTIVE_SANDBOX_STATUSES)
			)
		)
		.returning({ id: sandboxSession.id });
	return rows.length === 1;
}

export async function getOwnedSandboxStatus(
	database: Database,
	input: { sessionId: string; sandboxId: string }
): Promise<SandboxStatusRecord | null> {
	const rows = await database
		.select({
			sandboxId: sandboxSession.e2bSandboxId,
			status: sandboxSession.status,
			errorMessage: sandboxSession.errorMessage,
			expiresAt: sandboxSession.expiresAt,
			updatedAt: sandboxSession.updatedAt
		})
		.from(sandboxSession)
		.where(
			and(
				eq(sandboxSession.sessionId, input.sessionId),
				eq(sandboxSession.e2bSandboxId, input.sandboxId)
			)
		)
		.limit(1);

	const row = rows[0];
	if (!row || !row.sandboxId || !isSandboxSessionStatus(row.status)) return null;
	return {
		sandboxId: row.sandboxId,
		status: row.status,
		errorMessage: row.errorMessage,
		expiresAt: row.expiresAt,
		updatedAt: row.updatedAt
	};
}

export async function sandboxBelongsToSession(
	database: Database,
	input: { sessionId: string; sandboxId: string }
): Promise<boolean> {
	const status = await getOwnedSandboxStatus(database, input);
	return status !== null;
}

export async function countActiveSandboxes(database: Database, now: Date): Promise<number> {
	const rows = await database
		.select({ value: count() })
		.from(sandboxSession)
		.where(
			and(
				gte(sandboxSession.expiresAt, now),
				inArray(sandboxSession.status, ACTIVE_SANDBOX_STATUSES)
			)
		);
	return rows[0]?.value ?? 0;
}

export async function countActiveSandboxesForSession(
	database: Database,
	input: { sessionId: string; now: Date }
): Promise<number> {
	const rows = await database
		.select({ value: count() })
		.from(sandboxSession)
		.where(
			and(
				eq(sandboxSession.sessionId, input.sessionId),
				gte(sandboxSession.expiresAt, input.now),
				inArray(sandboxSession.status, ACTIVE_SANDBOX_STATUSES)
			)
		);
	return rows[0]?.value ?? 0;
}

export async function incrementRateLimitBucket(
	database: Database,
	input: { key: string; windowStart: Date; now: Date }
): Promise<number> {
	const rows = await database
		.insert(rateLimitBucket)
		.values({ key: input.key, windowStart: input.windowStart, count: 1, updatedAt: input.now })
		.onConflictDoUpdate({
			target: rateLimitBucket.key,
			set: {
				count: sql`${rateLimitBucket.count} + 1`,
				updatedAt: input.now
			},
			where: eq(rateLimitBucket.windowStart, input.windowStart)
		})
		.returning({ count: rateLimitBucket.count });

	if (rows.length === 1) return rows[0].count;

	const resetRows = await database
		.update(rateLimitBucket)
		.set({ windowStart: input.windowStart, count: 1, updatedAt: input.now })
		.where(eq(rateLimitBucket.key, input.key))
		.returning({ count: rateLimitBucket.count });
	return resetRows[0]?.count ?? 1;
}

export async function decrementRateLimitBucket(
	database: Database,
	input: { key: string; windowStart: Date; now: Date }
): Promise<number> {
	const rows = await database
		.update(rateLimitBucket)
		.set({
			count: sql`greatest(${rateLimitBucket.count} - 1, 0)`,
			updatedAt: input.now
		})
		.where(
			and(eq(rateLimitBucket.key, input.key), eq(rateLimitBucket.windowStart, input.windowStart))
		)
		.returning({ count: rateLimitBucket.count });
	return rows[0]?.count ?? 0;
}

export async function markExpiredSandboxes(
	database: Database,
	input: { now: Date }
): Promise<string[]> {
	const rows = await database
		.update(sandboxSession)
		.set({
			status: SANDBOX_SESSION_STATUS.Expired,
			updatedAt: input.now,
			terminatedAt: input.now
		})
		.where(
			and(
				lt(sandboxSession.expiresAt, input.now),
				inArray(sandboxSession.status, ACTIVE_SANDBOX_STATUSES)
			)
		)
		.returning({ sandboxId: sandboxSession.e2bSandboxId });
	return rows.map((row) => row.sandboxId).filter(isString);
}

export async function getMonitoringSnapshot(
	database: Database,
	input: { now: Date; globalLimit: number }
): Promise<MonitoringSnapshot> {
	const oneHourAgo = new Date(input.now.getTime() - 60 * 60 * 1000);
	const activeSandboxes = await countActiveSandboxes(database, input.now);
	const failureRows = await database
		.select({ value: count() })
		.from(sandboxSession)
		.where(
			and(
				eq(sandboxSession.status, SANDBOX_SESSION_STATUS.Error),
				gte(sandboxSession.updatedAt, oneHourAgo)
			)
		);
	const expiredRows = await database
		.select({ value: count() })
		.from(sandboxSession)
		.where(eq(sandboxSession.status, SANDBOX_SESSION_STATUS.Expired));

	return {
		activeSandboxes,
		globalLimit: input.globalLimit,
		recentBootstrapFailures: failureRows[0]?.value ?? 0,
		expiredSandboxes: expiredRows[0]?.value ?? 0
	};
}

export async function getExpiredRegisteredSandboxIds(
	database: Database,
	input: { now: Date; limit: number }
): Promise<string[]> {
	const rows = await database
		.select({ sandboxId: sandboxSession.e2bSandboxId })
		.from(sandboxSession)
		.where(
			and(
				lt(sandboxSession.expiresAt, input.now),
				inArray(sandboxSession.status, ACTIVE_SANDBOX_STATUSES),
				isNotNull(sandboxSession.e2bSandboxId)
			)
		)
		.orderBy(desc(sandboxSession.expiresAt))
		.limit(input.limit);
	return rows.map((row) => row.sandboxId).filter(isString);
}

function isSandboxSessionStatus(value: string): value is SandboxSessionStatus {
	return (
		value === SANDBOX_SESSION_STATUS.Provisioning ||
		value === SANDBOX_SESSION_STATUS.Bootstrapping ||
		value === SANDBOX_SESSION_STATUS.Ready ||
		value === SANDBOX_SESSION_STATUS.Error ||
		value === SANDBOX_SESSION_STATUS.Expired ||
		value === SANDBOX_SESSION_STATUS.Terminated
	);
}

function isString(value: string | null): value is string {
	return typeof value === 'string';
}
