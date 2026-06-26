<script lang="ts">
	import type { WorkerStatus } from '$lib/contracts/sandbox';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import Badge from '@lostgradient/cinder/badge';
	import CodeBlock from '@lostgradient/cinder/code-block';
	// Component CSS is expected to be loaded via @lostgradient/cinder/styles/all
	// at the app entry (src/routes/+layout.svelte) — owned by the integration pass.

	type Props = {
		/** Current worker lifecycle state, or null before the first restart. */
		workerStatus: WorkerStatus | null;
	};

	const { workerStatus }: Props = $props();
</script>

{#if workerStatus}
	<div class="worker-status-strip" data-phase={workerStatus.phase}>
		{#if workerStatus.phase === 'restarting'}
			<StatusDot connectionState="connecting" label="Worker restarting" />
			<Badge variant="warning">Restarting</Badge>
		{:else if workerStatus.phase === 'ready'}
			<StatusDot status="online" label="Worker ready" />
			<Badge variant="success">Ready</Badge>
		{:else if workerStatus.phase === 'compile-error'}
			<StatusDot status="danger" label="Compile error" />
			<Badge variant="danger">Compile Error</Badge>
			{#if workerStatus.stderr}
				<CodeBlock code={workerStatus.stderr} language="text" />
			{/if}
		{/if}
	</div>
{/if}
