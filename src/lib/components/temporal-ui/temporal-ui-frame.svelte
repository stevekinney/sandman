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
	 * We therefore probe reachability with an explicit HEAD fetch rather than
	 * relying on iframe lifecycle events.
	 */

	import StatusDot from '@lostgradient/cinder/status-dot';
	import type { StatusDotConnectionState } from '@lostgradient/cinder/status-dot';

	type Props = {
		/** The E2B sandbox ID. Used to construct the proxy URL `/sbx/{sandboxId}/ui/`. */
		sandboxId: string;
		/** Extra CSS classes forwarded to the root wrapper element. */
		class?: string;
	};

	let { sandboxId, class: className }: Props = $props();

	let connectionState = $state<StatusDotConnectionState>('connecting');

	const src = $derived(`/sbx/${sandboxId}/ui/`);

	$effect(() => {
		const controller = new AbortController();
		connectionState = 'connecting';

		fetch(src, { method: 'HEAD', signal: controller.signal })
			.then((response) => {
				connectionState = response.ok ? 'connected' : 'disconnected';
			})
			.catch((err: unknown) => {
				if (err instanceof Error && err.name !== 'AbortError') {
					connectionState = 'disconnected';
				}
			});

		return () => controller.abort();
	});
</script>

<div class="temporal-ui-frame {className ?? ''}">
	<div class="temporal-ui-frame__status">
		<StatusDot {connectionState} label="Temporal UI" showLabel />
	</div>
	<iframe {src} title="Temporal Web UI" class="temporal-ui-frame__iframe"></iframe>
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
	}

	.temporal-ui-frame__iframe {
		flex: 1;
		width: 100%;
		border: none;
	}
</style>
