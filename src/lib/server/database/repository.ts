import {
	and,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	notInArray,
	or,
	sql
} from 'drizzle-orm';
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
			-- Must flip EVERY expired active row's status unconditionally: the
			-- partial unique index sandbox_session_active_session_unique is keyed
			-- on status alone (not expires_at), so a row left in an active status
			-- past its own expiry collides with a same-session replacement insert
			-- below. VM reclamation is tracked independently via reclaimed_at —
			-- rows with an e2b_sandbox_id leave that column NULL here (their VM
			-- isn't confirmed dead yet) so the reconciler still finds and
			-- terminates them; rows with no VM have nothing to reclaim.
			update ${sandboxSession}
			set
				status = ${SANDBOX_SESSION_STATUS.Expired},
				updated_at = ${input.now},
				terminated_at = ${input.now},
				reclaimed_at = case when e2b_sandbox_id is null then ${input.now}::timestamptz else null end
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
			updatedAt: input.now,
			// The capacity sweep in reserveSandboxSlot can expire this exact row
			// before provisioning finished — since it had no VM yet at that
			// instant, the sweep correctly stamped reclaimedAt (nothing to
			// reclaim). Now that it DOES have a VM, that stamp is stale and would
			// hide a real VM from the reconciler forever. Reset it so the row is
			// reclaimable again if this VM later needs cleanup.
			reclaimedAt: null
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
		/**
		 * Pass `true` only when the caller has already confirmed the VM (if any)
		 * is terminated — e.g. the reaper's terminate callback runs this after
		 * `client.terminate()` resolves. Stamps `reclaimedAt`, which is what the
		 * reconciler queries on to find sandboxes still needing termination;
		 * never infer this from `status` alone (see schema.ts for why).
		 */
		reclaimed?: boolean;
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
					: undefined,
			reclaimedAt: input.reclaimed ? input.now : undefined
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

/**
 * Bulk-flips every expired active row's `status` to Expired for monitoring
 * bookkeeping. `excludeSandboxIds` must list every sandbox this process still
 * holds an in-memory handle for (the reconciler's `getExpiredSandboxIds`
 * excludes the same set from termination) — a bootstrap that outlasts its
 * reservation `expiresAt` is still legitimately in flight, and flipping its
 * row to Expired here (without ever touching its VM) would corrupt its
 * status mid-bootstrap: `reserveSandboxSlot` would then treat the row as
 * inactive and allow a replacement reservation for the same session, and the
 * original bootstrap's later Ready write would race it.
 */
export async function markExpiredSandboxes(
	database: Database,
	input: { now: Date; excludeSandboxIds: string[] }
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
				inArray(sandboxSession.status, ACTIVE_SANDBOX_STATUSES),
				// SQL's NOT IN treats a NULL column as neither true nor false, which
				// would silently exclude no-VM reservation rows too — those never
				// need this exclusion, so let them through via an explicit OR.
				input.excludeSandboxIds.length > 0
					? or(
							isNull(sandboxSession.e2bSandboxId),
							notInArray(sandboxSession.e2bSandboxId, input.excludeSandboxIds)
						)
					: undefined
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

/**
 * Sandboxes whose VM has not yet been confirmed terminated: has an E2B sandbox
 * ID and `reclaimedAt` is still NULL, and is either already expired OR already
 * in a terminal `Error` status. Deliberately status-agnostic on the "expired"
 * branch — `reserveSandboxSlot`'s capacity sweep flips `status` to Expired
 * immediately on expiry (required to avoid colliding with the active-session
 * unique index), independent of whether the VM has actually been killed yet,
 * so `reclaimedAt` is the only signal for that. The `Error` branch exists
 * because a bootstrap-failure row's `expiresAt` is still whatever was set at
 * reservation time — often minutes in the future — so without it, a VM whose
 * cleanup termination failed would sit unreclaimed until that far-future
 * expiry instead of being retried on the very next reconcile pass.
 */
export async function getExpiredRegisteredSandboxIds(
	database: Database,
	input: { now: Date; limit: number }
): Promise<string[]> {
	const rows = await database
		.select({ sandboxId: sandboxSession.e2bSandboxId })
		.from(sandboxSession)
		.where(
			and(
				isNotNull(sandboxSession.e2bSandboxId),
				isNull(sandboxSession.reclaimedAt),
				or(
					lt(sandboxSession.expiresAt, input.now),
					eq(sandboxSession.status, SANDBOX_SESSION_STATUS.Error)
				)
			)
		)
		.orderBy(desc(sandboxSession.expiresAt))
		.limit(input.limit);
	return rows.map((row) => row.sandboxId).filter(isString);
}

/**
 * Stamps `reclaimedAt` for a single sandbox whose VM has just been confirmed
 * terminated by the reconciler. Preserves an existing `Error` status instead
 * of always flipping to Expired — otherwise a bootstrap-failure row whose
 * cleanup termination initially failed (and is only now being reclaimed by
 * the reconciler's retry) would silently vanish from
 * `getMonitoringSnapshot()`'s `recentBootstrapFailures` count. Any other
 * status flips to Expired, matching the capacity sweep's normal behavior for
 * a sandbox that expired with no session ever re-POSTing.
 */
export async function markSandboxReclaimed(
	database: Database,
	input: { sandboxId: string; now: Date }
): Promise<void> {
	await database
		.update(sandboxSession)
		.set({
			status: sql`case when ${sandboxSession.status} = ${SANDBOX_SESSION_STATUS.Error} then ${sandboxSession.status} else ${SANDBOX_SESSION_STATUS.Expired} end`,
			// Leave updatedAt untouched when the row is already Error — reclaiming
			// its VM later must not disturb the original failure timestamp that
			// getMonitoringSnapshot()'s one-hour window keys off of.
			updatedAt: sql`case when ${sandboxSession.status} = ${SANDBOX_SESSION_STATUS.Error} then ${sandboxSession.updatedAt} else ${input.now} end`,
			terminatedAt: input.now,
			reclaimedAt: input.now
		})
		.where(eq(sandboxSession.e2bSandboxId, input.sandboxId));
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
