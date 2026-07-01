<script lang="ts">
	/**
	 * topology-strip.svelte — the persistent client → server → worker diagram.
	 *
	 * Links animate while messages flow, pulses travel along a link when a
	 * command fires, and both processes carry their real lifecycle controls:
	 * Kill / Restart on the worker, Stop / Start on the Temporal server (its
	 * state survives a stop — `start-dev` persists to a database file).
	 */
	import Button from '@lostgradient/cinder/button';
	import StatusDot from '@lostgradient/cinder/status-dot';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/status-dot/styles';
	import type { SessionState } from './session-state.svelte.ts';

	let { session, sandboxStatus }: { session: SessionState; sandboxStatus: string } = $props();

	const sandboxReady = $derived(sandboxStatus === 'ready');
	const serverUp = $derived(sandboxReady && session.serverOnline);
	const serverStarting = $derived(
		sandboxStatus === 'provisioning' ||
			sandboxStatus === 'bootstrapping' ||
			session.serverPending === 'starting'
	);
	const serverDot = $derived(serverStarting ? 'warning' : serverUp ? 'success' : 'danger');
	const serverSub = $derived(
		session.serverPending === 'starting'
			? 'recovering from persistence…'
			: !session.serverOnline
				? 'stopped · state persisted to disk'
				: sandboxReady
					? `${session.workflowEvents.length} events · state persisted`
					: 'starting inside the sandbox…'
	);
	const serverButtonDisabled = $derived(
		!sandboxReady || session.serverPending !== null || session.pendingControl !== null
	);

	const workerDot = $derived(
		!session.workerOnline ? 'danger' : session.workerRestarting ? 'warning' : 'success'
	);
	const workerSub = $derived(
		session.workerRestarting
			? 'replaying history…'
			: !session.workerOnline
				? 'process stopped'
				: !session.serverOnline
					? 'waiting for server…'
					: 'polling task queue'
	);

	const linkClientServerActive = $derived(session.running && serverUp);
	const linkServerWorkerActive = $derived(
		session.running && serverUp && session.workerOnline && !session.workerRestarting
	);
	const flowsClientServer = $derived(session.flows.filter((flow) => flow.link === 'cs'));
	const flowsServerWorker = $derived(session.flows.filter((flow) => flow.link === 'sw'));

	const workerButtonDisabled = $derived(
		session.workerOnline
			? !session.canDo('kill-worker')
			: session.pendingControl !== null || session.serverPending !== null || !session.serverOnline
	);
	const workerRecommended = $derived(session.recommendedControl === 'kill-worker');
</script>

<div class="topology" aria-label="System topology">
	<div class="topology__node">
		<span class="topology__client-dot" aria-hidden="true"></span>
		<div class="topology__node-copy">
			<p class="topology__node-name">Your application</p>
			<p class="topology__node-sub">signals · queries · updates</p>
		</div>
	</div>

	<div
		class="topology__link"
		class:topology__link--active={linkClientServerActive}
		class:topology__link--dead={!session.serverOnline}
	>
		{#each flowsClientServer as flow (flow.id)}
			<span class="topology__pulse" aria-hidden="true"></span>
		{/each}
	</div>

	<div
		class="topology__node topology__node--server"
		class:topology__node--down={!serverUp && !serverStarting}
		class:topology__node--replaying={session.serverPending === 'starting'}
	>
		<StatusDot status={serverDot} label="Temporal Server status" showLabel={false} />
		<div class="topology__node-copy">
			<p class="topology__node-name">Temporal Server</p>
			<p class="topology__node-sub topology__node-sub--accent">{serverSub}</p>
		</div>
		<Button
			variant={session.serverOnline ? 'ghost-danger' : 'primary'}
			size="xs"
			label={session.serverOnline ? 'Stop' : 'Start'}
			disabled={serverButtonDisabled}
			loading={session.serverPending !== null}
			title="Stop or start the Temporal dev server (state persists to disk)"
			onclick={() => void (session.serverOnline ? session.stopServer() : session.startServer())}
		/>
	</div>

	<div
		class="topology__link"
		class:topology__link--active={linkServerWorkerActive}
		class:topology__link--replaying={session.workerRestarting}
		class:topology__link--dead={!session.workerOnline && !session.workerRestarting}
	>
		{#each flowsServerWorker as flow (flow.id)}
			<span class="topology__pulse" aria-hidden="true"></span>
		{/each}
	</div>

	<div
		class="topology__node"
		class:topology__node--down={!session.workerOnline}
		class:topology__node--replaying={session.workerRestarting}
	>
		<StatusDot status={workerDot} label="Worker status" showLabel={false} />
		<div class="topology__node-copy">
			<p class="topology__node-name">Worker</p>
			<p class="topology__node-sub">{workerSub} · runs your code</p>
		</div>
		<Button
			variant={session.workerOnline ? 'ghost-danger' : 'primary'}
			size="xs"
			label={session.workerOnline ? 'Kill' : 'Restart'}
			disabled={workerButtonDisabled}
			loading={session.pendingControl === 'kill-worker'}
			class={workerRecommended ? 'topology__worker-button--recommended' : ''}
			title="Kill or restart the worker process"
			onclick={() => void session.dispatch('kill-worker')}
		/>
	</div>
</div>

<style>
	.topology {
		display: flex;
		align-items: center;
		flex: none;
		padding: 0.625rem 1.125rem;
		border-bottom: 1px solid var(--cinder-border-muted);
		background: var(--cinder-surface);
	}

	.topology__node {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.5625rem;
		border: 1px solid var(--cinder-border);
		border-radius: 0.625rem;
		padding: 0.5rem 0.75rem;
		background: var(--cinder-surface-raised);
	}

	.topology__node--server {
		flex: 1.15;
		border-color: color-mix(in oklch, var(--cinder-accent), transparent 50%);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--cinder-accent), transparent 86%);
	}

	.topology__node--down {
		border-color: var(--cinder-danger);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--cinder-danger), transparent 84%);
		opacity: 0.62;
	}

	.topology__node--replaying {
		border-color: var(--cinder-warning);
		box-shadow: 0 0 0 3px color-mix(in oklch, var(--cinder-warning), transparent 82%);
		opacity: 1;
	}

	.topology__client-dot {
		flex: none;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--cinder-text-subtle);
	}

	.topology__node-copy {
		min-width: 0;
		flex: 1;
	}

	.topology__node-name {
		margin: 0;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--cinder-text);
	}

	.topology__node-sub {
		margin: 0;
		font-size: 0.65rem;
		color: var(--cinder-text-subtle);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.topology__node-sub--accent {
		color: var(--cinder-accent-text);
		font-weight: 600;
	}

	.topology__link {
		flex: none;
		width: 2.875rem;
		position: relative;
		height: 0.75rem;
	}

	.topology__link::before {
		content: '';
		position: absolute;
		top: 50%;
		left: 0;
		right: 0;
		height: 2px;
		border-radius: 2px;
		transform: translateY(-50%);
		background: var(--cinder-border);
	}

	.topology__link--active::before {
		background: linear-gradient(90deg, transparent, var(--cinder-accent), transparent);
		background-size: 200% 100%;
		animation: topology-flow-dash 1.5s linear infinite;
	}

	.topology__link--replaying::before {
		background: linear-gradient(90deg, transparent, var(--cinder-warning), transparent);
		background-size: 200% 100%;
		animation: topology-flow-dash 1.5s linear infinite;
	}

	.topology__link--dead::before {
		background: var(--cinder-danger);
	}

	.topology__pulse {
		position: absolute;
		top: 50%;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--cinder-accent);
		box-shadow: 0 0 8px 1px var(--cinder-accent);
		animation: topology-flow-move 0.9s linear forwards;
	}

	.topology :global(.topology__worker-button--recommended) {
		box-shadow:
			0 0 0 2px var(--cinder-accent),
			0 0 15px -3px var(--cinder-accent);
	}

	@keyframes topology-flow-dash {
		from {
			background-position: 0% 0;
		}
		to {
			background-position: -200% 0;
		}
	}

	@keyframes topology-flow-move {
		0% {
			left: 3%;
			opacity: 0;
			transform: translateY(-50%) scale(0.6);
		}
		18% {
			opacity: 1;
			transform: translateY(-50%) scale(1);
		}
		82% {
			opacity: 1;
		}
		100% {
			left: 97%;
			opacity: 0;
			transform: translateY(-50%) scale(0.6);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.topology__link--active::before,
		.topology__link--replaying::before {
			animation: none;
		}

		.topology__pulse {
			animation: none;
			opacity: 0;
		}
	}
</style>
