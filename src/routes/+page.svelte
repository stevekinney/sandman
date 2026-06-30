<script lang="ts">
	/**
	 * +page.svelte — Sandman landing page.
	 *
	 * Presents the "New Session" button which provisions an E2B sandbox via
	 * POST /api/sandbox and redirects to /{sandboxId} once the handle is ready.
	 *
	 * When E2B_API_KEY is not set the server returns 503 and the error is
	 * surfaced inline so the user can diagnose and retry.
	 */
	import Button from '@lostgradient/cinder/button';
	import '@lostgradient/cinder/button/styles';

	let demoToken = $state('');
	let provisioning = $state(false);
	let provisionError = $state<string | null>(null);

	async function startSession(): Promise<void> {
		provisioning = true;
		provisionError = null;

		try {
			const sessionResponse = await fetch('/api/session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: demoToken })
			});
			if (!sessionResponse.ok) {
				provisionError = await sessionResponse.text();
				return;
			}

			const response = await fetch('/api/sandbox', { method: 'POST' });
			if (!response.ok) {
				const text = await response.text();
				provisionError = text;
				return;
			}
			const { sandboxId } = (await response.json()) as { sandboxId: string };
			window.location.href = `/${sandboxId}`;
		} catch (err) {
			provisionError = err instanceof Error ? err.message : String(err);
		} finally {
			provisioning = false;
		}
	}
</script>

<main class="landing">
	<h1>Sandman</h1>
	<p class="tagline">Ephemeral Temporal sandboxes in the browser.</p>

	<p class="description">
		Edit Temporal workflows live in a Monaco editor. Watch them execute in the real Temporal Web UI.
		Kill the worker mid-flight and watch the workflow resume — that's durable execution.
	</p>

	{#if provisionError}
		<p role="alert" class="error">{provisionError}</p>
	{/if}

	<label class="token-field">
		<span>Demo token</span>
		<input
			type="password"
			autocomplete="off"
			bind:value={demoToken}
			disabled={provisioning}
			placeholder="Enter demo token"
		/>
	</label>

	<Button
		class="start-button"
		onclick={startSession}
		disabled={provisioning || demoToken.trim().length === 0}
		aria-busy={provisioning}
		loading={provisioning}
		variant="primary"
		size="lg"
		label={provisioning ? 'Provisioning sandbox…' : 'New Session'}
	/>
</main>

<style>
	.landing {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-height: 100dvh;
		padding: 2rem;
		text-align: center;
		gap: 1rem;
	}

	h1 {
		font-size: 3rem;
		font-weight: 800;
		margin: 0;
		letter-spacing: -0.02em;
	}

	.tagline {
		font-size: 1.25rem;
		color: #6b7280;
		margin: 0;
	}

	.description {
		max-width: 480px;
		color: #4b5563;
		line-height: 1.6;
		margin: 0;
	}

	.error {
		color: #dc2626;
		font-size: 0.875rem;
		max-width: 480px;
	}

	.token-field {
		display: grid;
		gap: 0.35rem;
		width: min(100%, 22rem);
		text-align: left;
		color: #374151;
		font-size: 0.875rem;
	}

	.token-field input {
		width: 100%;
		box-sizing: border-box;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		padding: 0.65rem 0.75rem;
		font: inherit;
	}

	.landing :global(.start-button) {
		min-width: 9rem;
	}
</style>
