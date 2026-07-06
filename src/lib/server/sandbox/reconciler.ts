/**
 * reconciler.ts — cross-restart reclamation of expired sandboxes.
 *
 * The in-memory reaper only knows about sandboxes registered by THIS server
 * process. After a redeploy or crash, sandboxes provisioned by the previous
 * process still have live E2B VMs and active database rows, but no in-memory
 * handle — so the reaper can never reach them, the VM leaks until its own
 * provider timeout.
 *
 * VM reclamation is tracked by `reclaimedAt`, deliberately independent of
 * `status`: `status` must leave the active set the instant a row expires (to
 * avoid colliding with the session's active-row unique index — see
 * `reserveSandboxSlot`), but the VM behind it may still be running at that
 * exact moment. The reconciler queries on `reclaimedAt`, not `status`, so a
 * status flip elsewhere can never cause a VM to go unreclaimed.
 *
 * All I/O is injected so unit tests can drive a pass without a real database
 * or E2B API.
 */

/** Injected I/O for a reconcile pass. */
export type ReconcilerDeps = {
	/**
	 * Returns expired, VM-attached, not-yet-reclaimed sandbox IDs, at most
	 * `limit` (see `getExpiredRegisteredSandboxIds`).
	 */
	getExpiredSandboxIds(input: { now: Date; limit: number }): Promise<string[]>;
	/**
	 * Terminates one sandbox VM at the provider. Must succeed even when this
	 * process holds no in-memory handle for the sandbox.
	 */
	terminateSandbox(sandboxId: string): Promise<void>;
	/**
	 * Stamps `reclaimedAt` for a single sandbox whose VM was just confirmed
	 * terminated (see `markSandboxReclaimed`).
	 */
	markSandboxReclaimed(input: { sandboxId: string; now: Date }): Promise<void>;
	/**
	 * Bulk-flips every expired active row's `status` to Expired — bookkeeping
	 * only (see `markExpiredSandboxes`). Runs every pass regardless of whether
	 * any termination above failed: it never touches `reclaimedAt`, so it
	 * cannot cause a VM to be skipped.
	 */
	markExpiredSandboxes(input: { now: Date }): Promise<string[]>;
	/**
	 * Called for every failure: with a sandbox ID when one termination failed
	 * (that sandbox stays unreclaimed so the next pass retries it), without one
	 * when the pass itself failed (e.g. the database is unreachable).
	 */
	onError?(error: unknown, sandboxId?: string): void;
};

/** A reconciler that reclaims expired sandboxes from the database. */
export type Reconciler = {
	/** Runs a single reconcile pass. Never rejects — failures go to `onError`. */
	tick(): Promise<void>;
	/**
	 * Starts a recurring reconcile loop using real timers.
	 * @returns a cleanup function that stops the loop.
	 */
	start(intervalMs: number): () => void;
};

/**
 * Creates a `Reconciler` that reclaims expired sandboxes in batches of
 * `limit`, using an injected clock for deterministic time control.
 */
export function createReconciler(
	deps: ReconcilerDeps,
	options: { limit: number; now?: () => Date }
): Reconciler {
	const now = options.now ?? (() => new Date());
	let running = false;

	async function tick(): Promise<void> {
		// Serialize every invocation — the interval loop AND the startup call in
		// getSandboxRegistry() share this guard, so a slow startup pass can never
		// run concurrently with a scheduled one and double-reclaim the same rows.
		if (running) return;
		running = true;
		try {
			const passStartedAt = now();
			const sandboxIds = await deps.getExpiredSandboxIds({
				now: passStartedAt,
				limit: options.limit
			});

			// Each sandbox's reclamation is independent: one failure must not
			// block another's termination, or the mark, or the bookkeeping sweep
			// below — reclaimedAt is per-row, so a failure here only leaves that
			// one row unreclaimed for the next pass to retry.
			await Promise.all(
				sandboxIds.map(async (sandboxId) => {
					try {
						await deps.terminateSandbox(sandboxId);
						await deps.markSandboxReclaimed({ sandboxId, now: passStartedAt });
					} catch (error) {
						deps.onError?.(error, sandboxId);
					}
				})
			);

			// Bookkeeping only — flips status for monitoring/UI, never touches
			// reclaimedAt, so it's always safe regardless of the outcome above.
			await deps.markExpiredSandboxes({ now: passStartedAt });
		} catch (error) {
			deps.onError?.(error);
		} finally {
			running = false;
		}
	}

	return {
		tick,

		start(intervalMs) {
			// `tick` self-guards against overlap, so the interval can fire blindly.
			const handle = setInterval(() => void tick(), intervalMs);
			handle.unref?.();
			return () => clearInterval(handle);
		}
	};
}
