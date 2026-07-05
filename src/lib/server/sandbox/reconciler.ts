/**
 * reconciler.ts — cross-restart reclamation of expired sandboxes.
 *
 * The in-memory reaper only knows about sandboxes registered by THIS server
 * process. After a redeploy or crash, sandboxes provisioned by the previous
 * process still have live E2B VMs and active database rows, but no in-memory
 * handle — so the reaper can never reach them, the VM leaks until its own
 * provider timeout, and the row keeps counting against capacity limits. The
 * reconciler closes that gap: it reads expired-but-active rows from the
 * database, terminates their VMs at the provider, and marks the rows Expired.
 *
 * All I/O is injected so unit tests can drive the pass without a real
 * database or E2B API.
 */

/** Injected I/O for a reconcile pass. */
export type ReconcilerDeps = {
	/**
	 * Returns expired-but-active sandbox IDs from the database, at most `limit`
	 * (see `getExpiredRegisteredSandboxIds`).
	 */
	getExpiredSandboxIds(input: { now: Date; limit: number }): Promise<string[]>;
	/**
	 * Terminates one sandbox VM at the provider. Must succeed even when this
	 * process holds no in-memory handle for the sandbox.
	 */
	terminateSandbox(sandboxId: string): Promise<void>;
	/** Marks a single confirmed-terminated sandbox row Expired. */
	markSandboxExpired(input: { sandboxId: string; now: Date }): Promise<void>;
	/**
	 * Bulk-marks every expired active row Expired — including reservations that
	 * never received a VM (see `markExpiredSandboxes`).
	 */
	markExpiredSandboxes(input: { now: Date }): Promise<string[]>;
	/**
	 * Called for every failure: with a sandbox ID when one termination failed
	 * (that row stays active so the next pass retries it), without one when the
	 * pass itself failed (e.g. the database is unreachable).
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

			const terminated: string[] = [];
			let anyFailed = false;
			await Promise.all(
				sandboxIds.map(async (sandboxId) => {
					try {
						await deps.terminateSandbox(sandboxId);
						terminated.push(sandboxId);
					} catch (error) {
						anyFailed = true;
						deps.onError?.(error, sandboxId);
					}
				})
			);

			if (!anyFailed && sandboxIds.length < options.limit) {
				// Every VM expired as of `passStartedAt` is confirmed gone, so one
				// statement can sweep all expired active rows — including
				// reservations that never received a VM, which the per-ID path
				// below cannot reach.
				await deps.markExpiredSandboxes({ now: passStartedAt });
			} else {
				// A failed (or beyond-the-batch-limit) VM's row must stay in an
				// active status so the next pass retries its termination — mark
				// only confirmed kills.
				await Promise.all(
					terminated.map((sandboxId) => deps.markSandboxExpired({ sandboxId, now: passStartedAt }))
				);
			}
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
