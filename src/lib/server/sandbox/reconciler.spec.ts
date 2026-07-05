/**
 * reconciler.spec.ts — cross-restart sandbox reclamation unit tests.
 *
 * Runs in the "server" vitest project (node environment).
 * All database and E2B I/O is injected, so these tests model the cross-restart
 * scenario directly: the database knows about expired sandboxes that this
 * process never provisioned (no in-memory handle), and a reconcile pass must
 * terminate their VMs and stamp them reclaimed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createReconciler, type ReconcilerDeps } from './reconciler.ts';

type DepsOverrides = Partial<ReconcilerDeps>;

function createDeps(expiredIds: string[], overrides: DepsOverrides = {}) {
	const terminated: string[] = [];
	const reclaimed: string[] = [];
	const bulkMarks: Date[] = [];
	const errors: Array<{ error: unknown; sandboxId: string | undefined }> = [];

	const deps: ReconcilerDeps = {
		async getExpiredSandboxIds() {
			return expiredIds;
		},
		async terminateSandbox(sandboxId) {
			terminated.push(sandboxId);
		},
		async markSandboxReclaimed({ sandboxId }) {
			reclaimed.push(sandboxId);
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

	return { deps, terminated, reclaimed, bulkMarks, errors };
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

	it('marks each sandbox reclaimed independently after its own termination succeeds', async () => {
		const { deps, reclaimed } = createDeps(['sbx-old-1', 'sbx-old-2']);
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(reclaimed).toEqual(expect.arrayContaining(['sbx-old-1', 'sbx-old-2']));
		expect(reclaimed).toHaveLength(2);
	});

	it('runs the bookkeeping sweep every pass, even when no VM-attached rows are expired', async () => {
		const { deps, terminated, bulkMarks } = createDeps([]);
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(terminated).toHaveLength(0);
		expect(bulkMarks).toHaveLength(1);
	});

	it('a failed termination is not marked reclaimed, and does not block the other sandbox in the batch', async () => {
		const { deps, reclaimed, errors } = createDeps(['sbx-fails', 'sbx-ok'], {
			async terminateSandbox(sandboxId) {
				if (sandboxId === 'sbx-fails') throw new Error('E2B API unreachable');
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(reclaimed).toEqual(['sbx-ok']);
		expect(errors).toEqual([{ error: expect.any(Error), sandboxId: 'sbx-fails' }]);
	});

	it('the bookkeeping sweep still runs when a termination in the same pass fails', async () => {
		// Bookkeeping only flips `status` for monitoring — it never touches
		// reclaimedAt, so a failed termination elsewhere in the batch cannot make
		// this unsafe to run.
		const { deps, bulkMarks } = createDeps(['sbx-fails'], {
			async terminateSandbox() {
				throw new Error('E2B API unreachable');
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		await reconciler.tick();

		expect(bulkMarks).toHaveLength(1);
	});

	it('retries a previously failed termination on the next tick', async () => {
		let failOnce = true;
		const attempts: string[] = [];
		const { deps, reclaimed } = createDeps(['sbx-flaky'], {
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
		expect(reclaimed).toHaveLength(0); // failed — not yet reclaimed
		await reconciler.tick();

		expect(attempts).toEqual(['sbx-flaky', 'sbx-flaky']);
		expect(reclaimed).toEqual(['sbx-flaky']);
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

	it('a direct startup tick() does not overlap with the interval loop', async () => {
		// Mirrors getSandboxRegistry(): start() the loop, then fire an immediate
		// tick() for startup reclamation. A slow startup pass must not run
		// concurrently with the first scheduled pass.
		vi.useFakeTimers();
		let inFlight = 0;
		let maxInFlight = 0;
		const { deps } = createDeps([], {
			async getExpiredSandboxIds() {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise<void>((resolve) => setTimeout(resolve, 250_000));
				inFlight--;
				return [];
			}
		});
		const reconciler = createReconciler(deps, { limit: 25 });

		const stop = reconciler.start(60_000);
		void reconciler.tick(); // startup pass, spanning several intervals
		await vi.advanceTimersByTimeAsync(240_000);
		stop();

		expect(maxInFlight).toBe(1);
	});
});
