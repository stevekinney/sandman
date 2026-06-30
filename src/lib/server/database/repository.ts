import { and, count, desc, eq, gte, lt, sql } from 'drizzle-orm';
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
	input: { sessionId: string; now: Date }
): Promise<DemoSessionRecord | null> {
	const rows = await database
		.update(demoSession)
		.set({ lastSeenAt: input.now })
		.where(
			and(eq(demoSession.id, input.sessionId), eq(demoSession.status, DEMO_SESSION_STATUS.Active))
		)
		.returning({ id: demoSession.id, tokenHash: demoSession.tokenHash });
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

export async function updateSandboxStatus(
	database: Database,
	input: {
		sandboxId: string;
		status: SandboxSessionStatus;
		now: Date;
		errorMessage?: string;
	}
): Promise<void> {
	await database
		.update(sandboxSession)
		.set({
			status: input.status,
			updatedAt: input.now,
			errorMessage: input.errorMessage,
			bootstrappedAt: input.status === SANDBOX_SESSION_STATUS.Ready ? input.now : undefined,
			terminatedAt:
				input.status === SANDBOX_SESSION_STATUS.Terminated ||
				input.status === SANDBOX_SESSION_STATUS.Expired
					? input.now
					: undefined
		})
		.where(eq(sandboxSession.e2bSandboxId, input.sandboxId));
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
	if (!row || !isSandboxSessionStatus(row.status)) return null;
	return { ...row, status: row.status };
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
				sql`${sandboxSession.status} in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})`
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
				sql`${sandboxSession.status} in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})`
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
				sql`${sandboxSession.status} in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})`
			)
		)
		.returning({ sandboxId: sandboxSession.e2bSandboxId });
	return rows.map((row) => row.sandboxId);
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
				sql`${sandboxSession.status} in (${SANDBOX_SESSION_STATUS.Provisioning}, ${SANDBOX_SESSION_STATUS.Bootstrapping}, ${SANDBOX_SESSION_STATUS.Ready})`
			)
		)
		.orderBy(desc(sandboxSession.expiresAt))
		.limit(input.limit);
	return rows.map((row) => row.sandboxId);
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
