/**
 * reconciler.spec.ts — cross-restart sandbox reclamation unit tests.
 *
 * Runs in the "server" vitest project (node environment).
 * All database and E2B I/O is injected, so these tests model the cross-restart
 * scenario directly: the database knows about expired sandboxes that this
 * process never provisioned (no in-memory handle), and a reconcile pass must
 * terminate their VMs and mark their rows Expired.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReconciler, type ReconcilerDeps } from './reconciler.ts';

type DepsOverrides = Partial<ReconcilerDeps>;

function createDeps(expiredIds: string[], overrides: DepsOverrides = {}) {
	const terminated: string[] = [];
	const markedIndividually: string[] = [];
	const bulkMarks: Date[] = [];
	const errors: Array<{ error: unknown; sandboxId: string | undefined }> = [];

	const deps: ReconcilerDeps = {
		async getExpiredSandboxIds() {
			return expiredIds;
		},
		async terminateSandbox(sandboxId) {
			terminated.push(sandboxId);
		},
		async markSandboxExpired({ sandboxId }) {
			markedIndividually.push(sandboxId);
		},
		async markExpiredSandboxes({ now }) {
			bulkMarks.push(now);
			return expiredIds;
		},
		onError(error, sandboxId) {
			errors.push({ error, sandboxId });
		},
		...overrides
	};

	return { deps, terminated, markedIndividually, bulkMarks, errors };
}

describe('createReconciler', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('terminates every expired sandbox from the database — none were registered in this process', async () => {
		// The essential cross-restart property: nothing was register()-ed here,
		// the IDs come purely from the database.
		const { deps, terminated } = createDeps(['sbx-old-1', 'sbx-old-2']);
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(terminated).toEqual(expect.arrayContaining(['sbx-old-1', 'sbx-old-2']));
		expect(terminated).toHaveLength(2);
	});

	it('bulk-marks expired rows once every termination in the pass succeeded', async () => {
		const { deps, bulkMarks, markedIndividually } = createDeps(['sbx-old-1', 'sbx-old-2']);
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(bulkMarks).toHaveLength(1);
		expect(markedIndividually).toHaveLength(0);
	});

	it('runs the bulk sweep even when no VM-attached rows are expired (reclaims stale reservations)', async () => {
		const { deps, terminated, bulkMarks } = createDeps([]);
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(terminated).toHaveLength(0);
		expect(bulkMarks).toHaveLength(1);
	});

	it('keeps a failed termination in an active status so the next pass retries it', async () => {
		const { deps, markedIndividually, bulkMarks, errors } = createDeps(['sbx-fails', 'sbx-ok'], {
			async terminateSandbox(sandboxId) {
				if (sandboxId === 'sbx-fails') throw new Error('E2B API unreachable');
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		// Only the confirmed kill is marked; no bulk sweep may run, because it
		// would flip the failed sandbox's row and orphan its still-live VM.
		expect(markedIndividually).toEqual(['sbx-ok']);
		expect(bulkMarks).toHaveLength(0);
		expect(errors).toEqual([{ error: expect.any(Error), sandboxId: 'sbx-fails' }]);
	});

	it('retries a previously failed termination on the next tick', async () => {
		let failOnce = true;
		const attempts: string[] = [];
		const { deps, bulkMarks } = createDeps(['sbx-flaky'], {
			async terminateSandbox(sandboxId) {
				attempts.push(sandboxId);
				if (failOnce) {
					failOnce = false;
					throw new Error('transient provider error');
				}
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();
		expect(bulkMarks).toHaveLength(0); // failed pass — row stays active
		await reconciler.tick();

		expect(attempts).toEqual(['sbx-flaky', 'sbx-flaky']);
		expect(bulkMarks).toHaveLength(1); // clean retry — rows swept
	});

	it('skips the bulk sweep when the batch was truncated by the limit', async () => {
		// Two expired rows, limit 2: rows beyond the batch would be flipped by a
		// bulk sweep without their VMs being terminated — so mark per ID instead.
		const { deps, markedIndividually, bulkMarks } = createDeps(['sbx-a', 'sbx-b']);
		const reconciler = createReconciler(deps, { limit: 2 });

		await reconciler.tick();

		expect(bulkMarks).toHaveLength(0);
		expect(markedIndividually).toEqual(expect.arrayContaining(['sbx-a', 'sbx-b']));
	});

	it('reports a pass-level failure via onError instead of rejecting', async () => {
		const { deps, errors } = createDeps([], {
			async getExpiredSandboxIds() {
				throw new Error('database is unreachable');
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		await expect(reconciler.tick()).resolves.toBeUndefined();

		expect(errors).toEqual([{ error: expect.any(Error), sandboxId: undefined }]);
	});

	it('queries and marks with the same injected clock reading', async () => {
		const frozen = new Date('2026-07-05T12:00:00Z');
		let queriedAt: Date | undefined;
		const { deps, bulkMarks } = createDeps(['sbx-old'], {
			async getExpiredSandboxIds({ now }) {
				queriedAt = now;
				return ['sbx-old'];
			}
		});
		const reconciler = createReconciler(deps, { limit: 25, now: () => frozen });

		await reconciler.tick();

		// The sweep must use the same `now` as the query — a later reading could
		// flip rows that expired mid-pass whose VMs were never terminated.
		expect(queriedAt).toBe(frozen);
		expect(bulkMarks).toEqual([frozen]);
	});

	it('start() runs recurring passes and stop() halts them', async () => {
		vi.useFakeTimers();
		let passes = 0;
		const { deps } = createDeps([], {
			async getExpiredSandboxIds() {
				passes++;
				return [];
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		const stop = reconciler.start(60_000);
		await vi.advanceTimersByTimeAsync(180_000);
		expect(passes).toBe(3);

		stop();
		await vi.advanceTimersByTimeAsync(180_000);
		expect(passes).toBe(3);
	});

	it('start() never overlaps passes when a tick outlives the interval', async () => {
		vi.useFakeTimers();
		let inFlight = 0;
		let maxInFlight = 0;
		const { deps } = createDeps([], {
			async getExpiredSandboxIds() {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				// One slow pass spanning several intervals.
				await new Promise<void>((resolve) => setTimeout(resolve, 250_000));
				inFlight--;
				return [];
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		const stop = reconciler.start(60_000);
		await vi.advanceTimersByTimeAsync(240_000);
		stop();

		expect(maxInFlight).toBe(1);
	});
});
