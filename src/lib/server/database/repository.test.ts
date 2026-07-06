import { afterEach, describe, expect, it, vi } from 'vitest';
import { gt } from 'drizzle-orm';
import { sandboxSession } from './schema.ts';
import { reserveSandboxSlot, touchSandboxSession } from './repository.ts';

type TouchSandboxSessionDatabase = Parameters<typeof touchSandboxSession>[0];

vi.mock('drizzle-orm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('drizzle-orm')>();
	return {
		...actual,
		gt: vi.fn(actual.gt)
	};
});

describe('touchSandboxSession', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('requires the sandbox row to still be within its current expiry window', async () => {
		const now = new Date('2026-07-03T12:00:00.000Z');
		const returning = vi.fn().mockResolvedValue([{ id: 'row-1' }]);
		const where = vi.fn(() => ({ returning }));
		const set = vi.fn(() => ({ where }));
		const update = vi.fn(() => ({ set }));
		const database: TouchSandboxSessionDatabase = { update };

		await touchSandboxSession(database, { sandboxId: 'sandbox-1', now, ttlMs: 300_000 });

		expect(gt).toHaveBeenCalledWith(sandboxSession.expiresAt, now);
	});
});

describe('reserveSandboxSlot', () => {
	it('casts the reclaimed_at parameter so Postgres can type it against the timestamptz column', async () => {
		// Regression test for a production incident: an untyped parameter in
		// this CASE expression made Postgres infer `text` instead of
		// `timestamp with time zone`, so every reservation attempt threw
		// "column reclaimed_at is of type timestamp with time zone but
		// expression is of type text" — surfacing to users as a bare
		// "Internal Error" with sandboxes never provisioning.
		const now = new Date('2026-07-03T12:00:00.000Z');
		const execute = vi
			.fn()
			.mockResolvedValue({ rows: [{ status: 'reserved', reservation_id: 'r-1' }] });
		const database = { execute } as unknown as Parameters<typeof reserveSandboxSlot>[0];

		await reserveSandboxSlot(database, {
			sessionId: 'session-1',
			now,
			expiresAt: new Date(now.getTime() + 300_000),
			globalLimit: 20,
			perSessionLimit: 1
		});

		const query = execute.mock.calls[0][0];
		const chunks: unknown[] = query.queryChunks;
		const isStringChunk = (chunk: unknown): chunk is { value: string[] } =>
			Array.isArray((chunk as { value?: unknown[] })?.value);

		const anchorIndex = chunks.findIndex(
			(chunk) => isStringChunk(chunk) && chunk.value.join('').includes('reclaimed_at =')
		);
		expect(
			anchorIndex,
			'expected to find the "reclaimed_at =" chunk in the generated query'
		).not.toBe(-1);

		// Search a small window after the anchor for the cast, rather than
		// assuming a fixed offset — the exact chunk layout is a Drizzle
		// implementation detail that could shift without the underlying SQL
		// changing.
		const window = chunks.slice(anchorIndex + 1, anchorIndex + 4);
		const castChunk = window.find(
			(chunk) => isStringChunk(chunk) && chunk.value.join('').startsWith('::timestamptz')
		);
		expect(
			castChunk,
			'expected a "::timestamptz" cast shortly after "reclaimed_at ="'
		).toBeDefined();
	});
});
