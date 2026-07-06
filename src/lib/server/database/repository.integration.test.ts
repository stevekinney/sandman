import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDatabase, type Database } from './connection.ts';
import { SANDBOX_SESSION_STATUS, demoSession, sandboxSession } from './schema.ts';
import {
	createDemoSession,
	createSandboxSession,
	markSandboxReclaimed,
	reserveSandboxSlot
} from './repository.ts';

// Dedicated gate — deliberately NOT `DATABASE_URL`. `DATABASE_URL` is routinely
// populated in local dev shells/.env files, and `bun run test` auto-loads
// `.env`, so gating on it would run these destructive insert/delete tests
// against a real database on an ordinary local run. CI sets
// INTEGRATION_DATABASE_URL to the ephemeral Neon branch's connection string;
// nowhere else is it set, so this suite is a no-op skip everywhere except the
// `postgres-integration` CI job.
const integrationDatabaseUrl = process.env.INTEGRATION_DATABASE_URL;

// IMPORTANT: keep the client construction (and any throw) inside `beforeAll`,
// not in the `describe` body — Vitest executes `describe` bodies during test
// collection even when `skipIf` is true; only `beforeAll`/`it` bodies are
// withheld for a skipped suite.
describe.skipIf(!integrationDatabaseUrl)('repository (live Postgres integration)', () => {
	let database: Database;
	const suffix = Math.random().toString(36).slice(2, 10);
	const sessionId = `integration-session-${suffix}`;
	const now = new Date();

	beforeAll(async () => {
		database = createDatabase(integrationDatabaseUrl as string);
		await createDemoSession(database, { sessionId, tokenHash: `hash-${suffix}`, now });
	});

	afterAll(async () => {
		// sandbox_session rows cascade from the demo_session delete.
		await database.delete(demoSession).where(eq(demoSession.id, sessionId));
	});

	it('reserveSandboxSlot: the reclaimed_at CASE ::timestamptz cast is accepted by live Postgres', async () => {
		const reservation = await reserveSandboxSlot(database, {
			sessionId,
			now,
			expiresAt: new Date(now.getTime() + 900_000),
			globalLimit: 20,
			perSessionLimit: 1
		});
		expect(reservation.status).toBe('reserved');

		// Flip the reservation row out of the active set so subsequent inserts for
		// this session don't collide with the partial unique index.
		await database
			.update(sandboxSession)
			.set({ status: SANDBOX_SESSION_STATUS.Terminated })
			.where(eq(sandboxSession.sessionId, sessionId));
	});

	it('markSandboxReclaimed: a non-error row flips to expired', async () => {
		const sandboxId = `integration-vm-ready-${suffix}`;
		const updatedAt = new Date(now.getTime() - 60_000);
		await createSandboxSession(database, {
			sessionId,
			sandboxId,
			now: updatedAt,
			expiresAt: new Date(now.getTime() + 900_000)
		});
		await database
			.update(sandboxSession)
			.set({ status: SANDBOX_SESSION_STATUS.Ready, updatedAt })
			.where(eq(sandboxSession.e2bSandboxId, sandboxId));

		await markSandboxReclaimed(database, { sandboxId, now });

		const [row] = await database
			.select({ status: sandboxSession.status, updatedAt: sandboxSession.updatedAt })
			.from(sandboxSession)
			.where(eq(sandboxSession.e2bSandboxId, sandboxId));
		expect(row?.status).toBe(SANDBOX_SESSION_STATUS.Expired);
	});

	it('markSandboxReclaimed: an error row preserves its status and updatedAt', async () => {
		const sandboxId = `integration-vm-error-${suffix}`;
		const updatedAt = new Date(now.getTime() - 120_000);
		await createSandboxSession(database, {
			sessionId,
			sandboxId,
			now: updatedAt,
			expiresAt: new Date(now.getTime() + 900_000)
		});
		await database
			.update(sandboxSession)
			.set({ status: SANDBOX_SESSION_STATUS.Error, updatedAt })
			.where(eq(sandboxSession.e2bSandboxId, sandboxId));

		await markSandboxReclaimed(database, { sandboxId, now });

		const [row] = await database
			.select({ status: sandboxSession.status, updatedAt: sandboxSession.updatedAt })
			.from(sandboxSession)
			.where(eq(sandboxSession.e2bSandboxId, sandboxId));
		expect(row?.status).toBe(SANDBOX_SESSION_STATUS.Error);
		expect(row?.updatedAt?.getTime()).toBe(updatedAt.getTime());
	});
});
