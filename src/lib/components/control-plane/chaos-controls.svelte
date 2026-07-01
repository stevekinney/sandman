<script lang="ts">
	/**
	 * chaos-controls.svelte — the CHAOS panel for the Sandman demo.
	 *
	 * "Kill Worker" terminates the Node.js Temporal worker inside the E2B
	 * sandbox, demonstrating Temporal's durable-recovery feature.
	 * "Restart Worker" brings it back, and the workflow resumes exactly where
	 * it left off.
	 *
	 * Worker state is communicated via both text and icon (not color alone)
	 * so the UI is accessible to users who cannot perceive color differences.
	 */
	import Button from '@lostgradient/cinder/button';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import type { TemporalController } from './types.ts';

	let {
		controller,
		onkilled,
		onrestarted
	}: {
		controller: TemporalController;
		onkilled?: () => void;
		onrestarted?: () => void;
	} = $props();

	type WorkerState = 'running' | 'killed' | 'restarting';

	let workerState = $state<WorkerState>('running');
	let error = $state<string | null>(null);

	async function killWorker(): Promise<void> {
		error = null;
		try {
			await controller.killWorker();
			workerState = 'killed';
			onkilled?.();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function restartWorker(): Promise<void> {
		error = null;
		workerState = 'restarting';
		try {
			await controller.restartWorker();
			workerState = 'running';
			onrestarted?.();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			workerState = 'killed';
		}
	}

	const statusLabel = $derived(
		workerState === 'running'
			? 'Worker running'
			: workerState === 'killed'
				? 'Worker killed'
				: 'Worker restarting'
	);

	const connectionState = $derived(
		workerState === 'running'
			? ('connected' as const)
			: workerState === 'killed'
				? ('disconnected' as const)
				: ('connecting' as const)
	);
</script>

<section aria-label="Chaos controls">
	<!--
		StatusDot with live={true} renders role="status" aria-live="polite" and
		shows the label text in a visible <span>. No separate <p> is needed —
		duplicating the text would cause strict-mode failures in locator queries.
	-->
	<StatusDot {connectionState} showLabel label={statusLabel} live={true} />

	{#if error}
		<p role="alert" class="error">{error}</p>
	{/if}

	{#if workerState === 'running'}
		<Button label="Kill Worker" variant="danger" onclick={killWorker} />
	{:else if workerState === 'killed'}
		<Button label="Restart Worker" variant="primary" onclick={restartWorker} />
	{:else}
		<Button label="Restarting…" variant="secondary" loading={true} />
	{/if}
</section>
