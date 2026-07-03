import { afterEach, describe, expect, it, vi } from 'vitest';
import { gt } from 'drizzle-orm';
import { sandboxSession } from './schema.ts';
import { touchSandboxSession } from './repository.ts';
import type { Database } from './connection.ts';

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
		const database = { update } as unknown as Database;

		await touchSandboxSession(database, { sandboxId: 'sandbox-1', now, ttlMs: 300_000 });

		expect(gt).toHaveBeenCalledWith(sandboxSession.expiresAt, now);
	});
});
