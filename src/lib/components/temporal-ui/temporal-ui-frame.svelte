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

	type TemporalUiProbe = (url: string, signal: AbortSignal) => Promise<boolean>;

	type Props = {
		/** The E2B sandbox ID. Used to construct the proxy URL `/sbx/{sandboxId}/ui/`. */
		sandboxId: string;
		/** Current Sandman sandbox lifecycle status. */
		sandboxStatus?: string;
		/** Extra CSS classes forwarded to the root wrapper element. */
		class?: string;
		/** Reachability probe; injectable so browser tests do not hit the proxy route. */
		probe?: TemporalUiProbe;
		/** Optional iframe source override for tests that should not load the proxy route. */
		frameSource?: string;
		/**
		 * Called on genuine user gestures INSIDE the embedded Temporal UI. The
		 * proxied UI is same-origin but lives in a separate document, so its
		 * pointer/key events never reach the parent window's activity listeners —
		 * without this bridge, a user working only in the Temporal panel would let
		 * the sliding session TTL lapse mid-use.
		 */
		onActivity?: () => void;
	};

	async function probeTemporalUi(url: string, signal: AbortSignal): Promise<boolean> {
		const response = await fetch(url, {
			cache: 'no-store',
			method: 'GET',
			signal
		});
		return response.ok;
	}

	let {
		sandboxId,
		sandboxStatus = 'provisioning',
		class: className,
		probe = probeTemporalUi,
		frameSource,
		onActivity
	}: Props = $props();

	/**
	 * Bridges genuine gestures inside the same-origin proxied iframe to the
	 * parent's activity heartbeat. Re-attaches on every iframe `load` (the SPA
	 * keeps one contentWindow across internal navigation, but a full reload or
	 * re-key swaps it), and tears everything down when the iframe unmounts.
	 */
	function bridgeIframeActivity(iframe: HTMLIFrameElement) {
		if (!onActivity) return;
		const notify = () => onActivity?.();
		let attached: Window | null = null;

		function detach() {
			try {
				attached?.removeEventListener('pointerdown', notify);
				attached?.removeEventListener('keydown', notify);
			} catch {
				// contentWindow already torn down — nothing to remove.
			}
			attached = null;
		}

		function attach() {
			try {
				const win = iframe.contentWindow;
				if (!win || win === attached) return;
				detach();
				win.addEventListener('pointerdown', notify, { passive: true });
				win.addEventListener('keydown', notify, { passive: true });
				attached = win;
			} catch {
				// Cross-origin access shouldn't happen for the same-origin proxy;
				// if it ever does, silently skip rather than throw.
			}
		}

		iframe.addEventListener('load', attach);
		attach(); // in case the iframe is already loaded when this attaches
		return () => {
			iframe.removeEventListener('load', attach);
			detach();
		};
	}

	let connectionState = $state<StatusDotConnectionState>('connecting');
	let iframeRevision = $state(0);

	// The proxied Temporal Web UI is same-origin, so it shares localStorage
	// with this app. Its theme is a persisted store under the key "dark mode"
	// (JSON-encoded) — seed it before the iframe boots so the embedded UI
	// matches the workbench's dark theme. Runs client-side only ($effect).
	$effect(() => {
		try {
			if (localStorage.getItem('dark mode') === null) {
				localStorage.setItem('dark mode', 'true');
			}
		} catch {
			// Storage may be unavailable (privacy mode) — the UI just stays light.
		}
	});

	const src = $derived(`/sbx/${sandboxId}/ui/`);
	const iframeSource = $derived(frameSource ?? src);
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
		let activeController: AbortController | null = null;
		let retryTimer: ReturnType<typeof setTimeout> | null = null;
		let resolveRetry: (() => void) | null = null;
		connectionState = 'connecting';

		function waitForRetry(): Promise<void> {
			return new Promise<void>((resolve) => {
				resolveRetry = resolve;
				retryTimer = setTimeout(() => {
					retryTimer = null;
					resolveRetry = null;
					resolve();
				}, 2000);
			});
		}

		async function probeUntilConnected(): Promise<void> {
			while (!cancelled) {
				const controller = new AbortController();
				activeController = controller;
				try {
					const reachable = await probe(src, controller.signal);
					if (cancelled) return;
					if (reachable) {
						connectionState = 'connected';
						iframeRevision += 1;
						return;
					}
					connectionState = 'disconnected';
				} catch (err: unknown) {
					if (err instanceof Error && err.name === 'AbortError') return;
					connectionState = 'disconnected';
				}

				await waitForRetry();
			}
		}

		void probeUntilConnected();

		return () => {
			cancelled = true;
			activeController?.abort();
			if (retryTimer !== null) clearTimeout(retryTimer);
			resolveRetry?.();
		};
	});
</script>

<div class="temporal-ui-frame {className ?? ''}">
	<div class="temporal-ui-frame__status">
		<StatusDot {connectionState} label="Temporal UI" showLabel />
	</div>
	{#if iframeReady}
		{#key iframeRevision}
			<iframe
				src={iframeSource}
				data-proxied-src={src}
				title="Temporal Web UI"
				class="temporal-ui-frame__iframe"
				{@attach bridgeIframeActivity}
			></iframe>
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
		background: var(--cinder-bg);
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
		background: var(--cinder-surface);
		color: var(--cinder-text);
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
		color: var(--cinder-text-muted);
		line-height: 1.5;
	}

	.temporal-ui-frame__spinner {
		width: 2rem;
		height: 2rem;
		border: 3px solid var(--cinder-border);
		border-top-color: var(--cinder-accent);
		border-radius: 999px;
		animation: temporal-ui-spin 0.9s linear infinite;
	}

	@keyframes temporal-ui-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
