<script lang="ts">
	/**
	 * temporal-ui-frame.svelte — iframe wrapper for the Temporal Web UI proxy.
	 *
	 * Embeds the Temporal Web UI from the proxied same-origin route at
	 * `/sbx/{sandboxId}/ui/` inside an iframe. Uses Cinder's `StatusDot` with
	 * `connectionState` to reflect whether the upstream is reachable.
	 *
	 * Connection state transitions:
	 * - `connecting` — initial state; probe in flight.
	 * - `connected`  — proxy returned a 2xx response (upstream is reachable).
	 * - `disconnected` — proxy returned a non-2xx (e.g. 502) or the fetch threw.
	 *
	 * NOTE: iframe `onerror` does NOT fire for HTTP 502 responses — the browser
	 * loads the 502 error document successfully and fires `onload` instead.
	 * We therefore probe reachability with an explicit fetch rather than relying
	 * on iframe lifecycle events. Temporal Web UI returns 405 for HEAD, so this
	 * must be a GET probe.
	 */

	import StatusDot from '@lostgradient/cinder/status-dot';
	import type { StatusDotConnectionState } from '@lostgradient/cinder/status-dot';

	type Props = {
		/** The E2B sandbox ID. Used to construct the proxy URL `/sbx/{sandboxId}/ui/`. */
		sandboxId: string;
		/** Current Sandman sandbox lifecycle status. */
		sandboxStatus?: string;
		/** Extra CSS classes forwarded to the root wrapper element. */
		class?: string;
	};

	let { sandboxId, sandboxStatus = 'provisioning', class: className }: Props = $props();

	let connectionState = $state<StatusDotConnectionState>('connecting');
	let iframeRevision = $state(0);

	const src = $derived(`/sbx/${sandboxId}/ui/`);
	const iframeReady = $derived(connectionState === 'connected');
	const startupTitle = $derived(
		sandboxStatus === 'ready' ? 'Connecting to Temporal UI' : 'Starting Temporal services'
	);
	const startupDetail = $derived(
		sandboxStatus === 'ready'
			? 'The sandbox is ready. Sandman is waiting for the proxied Temporal Web UI to answer.'
			: 'Temporal server, worker, and Web UI are booting inside the sandbox. The UI will appear here automatically.'
	);

	$effect(() => {
		let cancelled = false;
		connectionState = 'connecting';

		async function probeUntilConnected(): Promise<void> {
			while (!cancelled) {
				const controller = new AbortController();
				try {
					const response = await fetch(src, {
						cache: 'no-store',
						method: 'GET',
						signal: controller.signal
					});
					if (response.ok) {
						connectionState = 'connected';
						iframeRevision += 1;
						return;
					}
					connectionState = 'disconnected';
				} catch (err: unknown) {
					if (err instanceof Error && err.name === 'AbortError') return;
					connectionState = 'disconnected';
				}

				await new Promise<void>((resolve) => setTimeout(resolve, 2000));
			}
		}

		void probeUntilConnected();

		return () => {
			cancelled = true;
		};
	});
</script>

<div class="temporal-ui-frame {className ?? ''}">
	<div class="temporal-ui-frame__status">
		<StatusDot {connectionState} label="Temporal UI" showLabel />
	</div>
	{#if iframeReady}
		{#key iframeRevision}
			<iframe {src} title="Temporal Web UI" class="temporal-ui-frame__iframe"></iframe>
		{/key}
	{:else}
		<div class="temporal-ui-frame__startup" aria-live="polite">
			<div class="temporal-ui-frame__spinner" aria-hidden="true"></div>
			<div>
				<h2>{startupTitle}</h2>
				<p>{startupDetail}</p>
			</div>
		</div>
	{/if}
</div>

<style>
	.temporal-ui-frame {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
	}

	.temporal-ui-frame__status {
		padding: 0.25rem 0.5rem;
		flex-shrink: 0;
		background: #020817;
	}

	.temporal-ui-frame__iframe {
		flex: 1;
		width: 100%;
		border: none;
	}

	.temporal-ui-frame__startup {
		display: grid;
		place-items: center;
		align-content: center;
		gap: 1rem;
		flex: 1;
		padding: 2rem;
		background: linear-gradient(180deg, rgba(15, 23, 42, 0.72), rgba(2, 6, 23, 0.92)), #020817;
		color: #e2e8f0;
		text-align: center;
	}

	.temporal-ui-frame__startup h2 {
		margin: 0;
		font-size: 1.35rem;
		line-height: 1.2;
	}

	.temporal-ui-frame__startup p {
		max-width: 30rem;
		margin: 0.6rem auto 0;
		color: #94a3b8;
		line-height: 1.5;
	}

	.temporal-ui-frame__spinner {
		width: 2rem;
		height: 2rem;
		border: 3px solid rgba(148, 163, 184, 0.28);
		border-top-color: #7dd3fc;
		border-radius: 999px;
		animation: temporal-ui-spin 0.9s linear infinite;
	}

	@keyframes temporal-ui-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
