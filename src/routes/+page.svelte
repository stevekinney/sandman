<script lang="ts">
	/**
	 * +page.svelte — Sandman landing page.
	 *
	 * Presents the "New Session" button which provisions an E2B sandbox via
	 * POST /api/sandbox and redirects to /{sandboxId} once the handle is ready.
	 *
	 * Server-side configuration failures are shown as generic availability
	 * errors so the browser never exposes deployment internals.
	 */
	import Alert from '@lostgradient/cinder/alert';
	import Button from '@lostgradient/cinder/button';
	import Input from '@lostgradient/cinder/input';
	import '@lostgradient/cinder/alert/styles';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/input/styles';

	let demoToken = $state('');
	let provisioning = $state(false);
	let provisionError = $state<string | null>(null);

	async function startSession(event?: SubmitEvent): Promise<void> {
		event?.preventDefault();
		provisioning = true;
		provisionError = null;

		try {
			const sessionResponse = await fetch('/api/session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: demoToken })
			});
			if (!sessionResponse.ok) {
				provisionError = await getUserFacingErrorMessage(
					sessionResponse,
					'Could not start a session.'
				);
				return;
			}

			const response = await fetch('/api/sandbox', { method: 'POST' });
			if (!response.ok) {
				provisionError = await getUserFacingErrorMessage(response, 'Could not start the sandbox.');
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

	async function getUserFacingErrorMessage(response: Response, fallback: string): Promise<string> {
		const rawMessage = await readResponseErrorMessage(response);
		if (isServerConfigurationError(rawMessage)) {
			return 'Sandman is not ready to start new sessions right now.';
		}
		if (rawMessage === 'Invalid demo token') {
			return 'That invite code did not work. Check the code and try again.';
		}
		return rawMessage || fallback;
	}

	function isServerConfigurationError(message: string): boolean {
		return [
			'SANDMAN_SESSION_SECRET',
			'SANDMAN_DEMO_TOKEN_SHA256',
			'DATABASE_URL',
			'E2B_API_KEY'
		].some((configurationKey) => message.includes(configurationKey));
	}

	async function readResponseErrorMessage(response: Response): Promise<string> {
		const body = await response.text();
		try {
			const parsed: unknown = JSON.parse(body);
			if (isMessagePayload(parsed)) return parsed.message;
		} catch {
			// Plain-text errors are already usable after trimming below.
		}
		return body.trim();
	}

	function isMessagePayload(value: unknown): value is { message: string } {
		return (
			typeof value === 'object' &&
			value !== null &&
			'message' in value &&
			typeof value.message === 'string'
		);
	}
</script>

<main class="landing">
	<h1>Sandman</h1>
	<p class="tagline">Ephemeral Temporal sandboxes in the browser.</p>

	<p class="description">
		Start a real food-ordering workflow, watch each durable step unfold, then stop the worker
		mid-flight and see Temporal resume exactly where it left off.
	</p>

	{#if provisionError}
		<div class="landing-alert">
			<Alert variant="danger">{provisionError}</Alert>
		</div>
	{/if}

	<form class="session-form" onsubmit={startSession}>
		<div class="token-field">
			<Input
				id="demo-token"
				class="token-input"
				label="Demo token"
				type="password"
				autocomplete="off"
				bind:value={demoToken}
				disabled={provisioning}
				placeholder="Enter demo token"
			/>
		</div>

		<Button
			class="start-button"
			type="submit"
			disabled={provisioning || demoToken.trim().length === 0}
			aria-busy={provisioning}
			loading={provisioning}
			variant="primary"
			size="lg"
			label={provisioning ? 'Provisioning sandbox…' : 'New Session'}
		/>
	</form>
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

	.landing-alert {
		width: min(100%, 32rem);
		text-align: left;
	}

	.session-form {
		display: flex;
		width: min(100%, 22rem);
		flex-direction: column;
		align-items: center;
		gap: 1.5rem;
	}

	.token-field {
		width: 100%;
		text-align: left;
	}

	.landing :global(.start-button) {
		min-width: 9rem;
	}
</style>
