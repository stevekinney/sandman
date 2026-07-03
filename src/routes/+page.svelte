<script lang="ts">
	/**
	 * +page.svelte — Sandman landing page.
	 *
	 * Marketing splash for the ephemeral Temporal sandbox. The "Get started"
	 * section provisions a real sandbox: POST /api/session exchanges the demo
	 * token, POST /api/sandbox boots the MicroVM, then we redirect to /{sandboxId}.
	 *
	 * Server-side configuration failures are shown as generic availability
	 * errors so the browser never exposes deployment internals.
	 */
	import Alert from '@lostgradient/cinder/alert';
	import Badge from '@lostgradient/cinder/badge';
	import Button from '@lostgradient/cinder/button';
	import Input from '@lostgradient/cinder/input';
	import '@lostgradient/cinder/alert/styles';
	import '@lostgradient/cinder/badge/styles';
	import '@lostgradient/cinder/button/styles';
	import '@lostgradient/cinder/input/styles';
	import { SITE_DESCRIPTION, SITE_TITLE } from '$lib/metadata';
	import { concepts, faqs, phases, surfaces, tour, type IconPart } from './splash-content';

	let demoToken = $state('');
	let provisioning = $state(false);
	let provisionError = $state<string | null>(null);

	// Resolved color theme applied via `data-theme` on the root wrapper. Undefined
	// on the server and on first hydration so SSR markup matches; a post-mount
	// effect resolves it from the stored preference or the OS setting.
	let theme = $state<'light' | 'dark' | undefined>(undefined);
	const isDark = $derived(theme === 'dark');
	const startDisabled = $derived(provisioning || demoToken.trim().length === 0);

	$effect(() => {
		// Runs once after mount — reads only non-reactive sources, so it never re-runs.
		let stored: string | null = null;
		try {
			stored = localStorage.getItem('sandman-theme');
		} catch {
			// Private-mode or blocked storage: fall through to the OS preference.
		}
		if (stored === 'dark' || stored === 'light') {
			theme = stored;
			return;
		}
		theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
	});

	$effect(() => {
		// Cinder's tokens resolve `light-dark()` against the color-scheme of the
		// element where they are declared (`:root`), so the theme must be applied to
		// <html>, not a nested wrapper. Restore the prior value on teardown so the
		// preference never leaks into other routes after client-side navigation.
		if (!theme) return;
		const root = document.documentElement;
		const previous = root.getAttribute('data-theme');
		root.setAttribute('data-theme', theme);
		return () => {
			if (previous === null) root.removeAttribute('data-theme');
			else root.setAttribute('data-theme', previous);
		};
	});

	function toggleTheme(): void {
		const next = theme === 'dark' ? 'light' : 'dark';
		theme = next;
		try {
			localStorage.setItem('sandman-theme', next);
		} catch {
			// Persistence is best-effort; the toggle still works for this session.
		}
	}

	function scrollToStart(event?: Event): void {
		event?.preventDefault();
		document.getElementById('get-started')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

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

<svelte:head>
	<title>{SITE_TITLE}</title>
	<meta name="description" content={SITE_DESCRIPTION} />
	<meta property="og:title" content={SITE_TITLE} />
	<meta property="og:description" content={SITE_DESCRIPTION} />
	<meta name="twitter:title" content={SITE_TITLE} />
	<meta name="twitter:description" content={SITE_DESCRIPTION} />
</svelte:head>

<!-- Reusable 24×24 line-icon renderer (no {@html}; SVG namespace stays correct). -->
{#snippet iconGlyph(parts: IconPart[])}
	<svg viewBox="0 0 24 24" class="sd-svg">
		{#each parts as part, index (index)}
			{#if part.kind === 'path'}
				<path d={part.d} />
			{:else if part.kind === 'circle'}
				<circle cx={part.cx} cy={part.cy} r={part.r} />
			{:else if part.kind === 'rect'}
				<rect x={part.x} y={part.y} width={part.w} height={part.h} rx={part.rx} />
			{:else if part.kind === 'polyline'}
				<polyline points={part.points} />
			{:else if part.kind === 'ellipse'}
				<ellipse cx={part.cx} cy={part.cy} rx={part.rx} ry={part.ry} />
			{/if}
		{/each}
	</svg>
{/snippet}

{#snippet arrowRight()}
	<svg viewBox="0 0 24 24" class="sd-svg"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
{/snippet}

{#snippet githubGlyph()}
	<svg viewBox="0 0 24 24" class="sd-svg"
		><path d="M6 3v12" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path
			d="M18 9a9 9 0 0 1-9 9"
		/></svg
	>
{/snippet}

<div class="sandman-splash">
	<!-- ============ NAV ============ -->
	<header class="sd-nav">
		<div class="sd-nav__inner">
			<a href="#top" aria-label="Back to top" class="sd-brand">
				<span class="sd-brand__mark">
					<svg viewBox="0 0 24 24" class="sd-svg" style="width:1.1rem;height:1.1rem;"
						><path d="M5 22h14" /><path d="M5 2h14" /><path
							d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"
						/><path
							d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"
						/></svg
					>
				</span>
			</a>
			<nav class="sd-nav__links">
				<a href="#how">How it works</a>
				<a href="#concepts">Concepts</a>
				<a href="#tour">Guided tour</a>
				<a href="#faq">FAQ</a>
			</nav>
			<div class="sd-nav__actions">
				<Button
					iconOnly
					variant="ghost"
					size="sm"
					aria-label="Toggle color theme"
					title="Toggle theme"
					onclick={toggleTheme}
				>
					{#if isDark}
						<svg viewBox="0 0 24 24" class="sd-svg"
							><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path
								d="m4.93 4.93 1.41 1.41"
							/><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path
								d="m6.34 17.66-1.41 1.41"
							/><path d="m19.07 4.93-1.41 1.41" /></svg
						>
					{:else}
						<svg viewBox="0 0 24 24" class="sd-svg"
							><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg
						>
					{/if}
				</Button>
				<Button
					href="https://github.com/stevekinney/sandman"
					variant="secondary"
					size="sm"
					leadingIcon={githubGlyph}
					label="GitHub"
				/>
				<Button variant="primary" size="sm" onclick={scrollToStart} label="Start a session" />
			</div>
		</div>
	</header>

	<span id="top"></span>

	<!-- ============ HERO ============ -->
	<section class="sd-hero">
		<div class="sd-hero__grid">
			<div>
				<div class="sd-eyebrow-pill">
					<span class="sd-dot sd-dot--success"></span>
					Powered by Temporal
				</div>
				<h1 class="sd-hero__title">A real Temporal server in your browser, in seconds.</h1>
				<p class="sd-hero__lede">
					Boots an ephemeral sandbox running a real Temporal dev server and a live worker. Edit the
					workflow, start a durable order, then kill the worker mid-flight and watch it resume
					exactly where it left off.
				</p>
				<div class="sd-hero__cta">
					<Button
						variant="primary"
						size="lg"
						onclick={scrollToStart}
						trailingIcon={arrowRight}
						label="Start a session"
					/>
				</div>
				<div class="sd-hero__meta">
					<span
						><svg viewBox="0 0 24 24" class="sd-svg"
							><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg
						>Ephemeral · ~5-minute sessions</span
					>
					<span
						><svg viewBox="0 0 24 24" class="sd-svg"
							><path
								d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"
							/><path d="m9 12 2 2 4-4" /></svg
						>Nothing to install</span
					>
				</div>
			</div>

			<!-- App preview mock -->
			<div class="sd-preview">
				<div class="sd-preview__bar">
					<span class="sd-dot sd-dot--danger"></span>
					<span class="sd-dot sd-dot--warning"></span>
					<span class="sd-dot sd-dot--success"></span>
					<span class="sd-preview__file">sandman · order-workflow.ts</span>
				</div>
				<div class="sd-preview__body">
					<div class="sd-code">
						<div><span class="sd-kw">export async function</span> orderWorkflow() &#123;</div>
						<div class="sd-indent-1"><span class="sd-comment">// durable, replayable</span></div>
						<div class="sd-indent-1"><span class="sd-kw">await</span> charge(payment);</div>
						<div class="sd-indent-1"><span class="sd-kw">await</span> notify(restaurant);</div>
						<div class="sd-indent-1">
							<span class="sd-kw">const</span> ok = <span class="sd-kw">await</span> condition(
						</div>
						<div class="sd-indent-2">() =&gt; accepted, <span class="sd-str">'15m'</span></div>
						<div class="sd-indent-1">);</div>
						<div class="sd-indent-1"><span class="sd-kw">await</span> deliver(order);</div>
						<div>&#125;</div>
					</div>
					<div class="sd-history">
						<div class="sd-history__head">Event history</div>
						<div class="sd-history__list">
							<div><span class="sd-dot sd-dot--success"></span><span>WorkflowStarted</span></div>
							<div>
								<span class="sd-dot sd-dot--success"></span><span>ActivityCompleted · charge</span>
							</div>
							<div>
								<span class="sd-dot sd-dot--success"></span><span>TimerStarted · 15m</span>
							</div>
							<div>
								<span class="sd-dot sd-dot--warning"></span><span>SignalReceived · accept</span>
							</div>
							<div>
								<span class="sd-dot sd-dot--info"></span><span>ChildWorkflow · delivery</span>
							</div>
						</div>
						<div class="sd-history__actions">
							<span class="cinder-button" data-cinder-variant="soft" data-cinder-size="xs"
								><span>Send signal</span></span
							>
							<span class="cinder-button" data-cinder-variant="soft-danger" data-cinder-size="xs"
								><span class="cinder-button__icon"
									><svg viewBox="0 0 24 24" class="sd-svg"
										><path d="M12 2v10" /><path d="M18.4 6.6a9 9 0 1 1-12.77.04" /></svg
									></span
								><span>Kill worker</span></span
							>
						</div>
					</div>
				</div>
			</div>
		</div>
	</section>

	<!-- ============ HOW IT WORKS — animated kill/recover ============ -->
	<section id="how" class="sd-band">
		<div class="sd-band__inner sd-band__inner--narrow">
			<div class="sd-section-head sd-section-head--center">
				<div class="sd-kicker">The durability demo</div>
				<h2 class="sd-h2">Kill the worker. Watch it recover.</h2>
				<p class="sd-section-lede sd-section-lede--center">
					Workflow state lives in the Temporal server, not the worker process. So when the process
					dies, nothing is lost — a restarted worker replays history and picks up exactly where it
					stopped.
				</p>
			</div>

			<div class="sd-diagram">
				<!-- worker -->
				<div class="sd-diagram__worker-row">
					<div class="sd-anim sd-worker">
						<div class="sd-anim sd-worker__fade">
							<span class="sd-anim sd-worker__pulse"></span>
							<div>
								<div class="sd-worker__title">Worker process</div>
								<div class="sd-worker__sub">running order-workflow.ts</div>
							</div>
						</div>
						<span class="sd-anim sd-worker__kill">
							<svg
								viewBox="0 0 24 24"
								class="sd-svg"
								style="width:1.75rem;height:1.75rem;stroke-width:2.5;"
								><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
							>
						</span>
					</div>
				</div>

				<!-- connector -->
				<div class="sd-connector">
					<svg viewBox="0 0 24 40" class="sd-connector__svg"
						><path d="M12 2v30" /><path d="m6 26 6 6 6-6" /></svg
					>
				</div>

				<!-- progress / history -->
				<div class="sd-progress">
					<div class="sd-progress__labels">
						<span>Workflow progress</span><span>event history</span>
					</div>
					<div class="sd-progress__track">
						<div class="sd-anim sd-progress__fill"></div>
					</div>
				</div>

				<!-- temporal server (constant) -->
				<div class="sd-anim sd-server">
					<span class="sd-server__icon">
						<svg viewBox="0 0 24 24" class="sd-svg"
							><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path
								d="M3 12a9 3 0 0 0 18 0"
							/></svg
						>
					</span>
					<div class="sd-server__text">
						<div class="sd-server__title">Temporal server</div>
						<div class="sd-server__sub">
							Holds the full event history — survives every worker restart.
						</div>
					</div>
					<Badge variant="success">State preserved</Badge>
				</div>

				<!-- captions -->
				<div class="sd-phases">
					{#each phases as phase (phase.n)}
						<div class="sd-phase">
							<span class="sd-phase__n">{phase.n}</span>
							<div>
								<span class="sd-phase__title">{phase.title}</span>
								<span class="sd-phase__body"> — {phase.body}</span>
							</div>
						</div>
					{/each}
				</div>
			</div>
		</div>
	</section>

	<!-- ============ THREE SURFACES ============ -->
	<section class="sd-wide">
		<div class="sd-section-head">
			<div class="sd-kicker">One screen, three surfaces</div>
			<h2 class="sd-h2">Edit, run, and inspect — side by side.</h2>
		</div>
		<div class="sd-surfaces">
			{#each surfaces as surface (surface.title)}
				<div class="sd-card">
					<span class="sd-card__icon sd-card__icon--lg">{@render iconGlyph(surface.icon)}</span>
					<h3 class="sd-card__title">{surface.title}</h3>
					<p class="sd-card__body">{surface.body}</p>
				</div>
			{/each}
		</div>
	</section>

	<!-- ============ CONCEPTS GRID ============ -->
	<section id="concepts" class="sd-band">
		<div class="sd-band__inner">
			<div class="sd-section-head">
				<div class="sd-kicker">A deliberately over-engineered food order</div>
				<h2 class="sd-h2">Every core Temporal concept, in one workflow.</h2>
				<p class="sd-section-lede">
					The demo workflow is intentionally maximal, so you can trigger each primitive from the
					control plane and watch it land in real history.
				</p>
			</div>
			<div class="sd-concepts">
				{#each concepts as concept (concept.title)}
					<div class="sd-concept">
						<div class="sd-concept__head">
							<span class="sd-card__icon">{@render iconGlyph(concept.icon)}</span>
							<h3 class="sd-concept__title">{concept.title}</h3>
						</div>
						<p class="sd-concept__body">{concept.body}</p>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<!-- ============ GUIDED TOUR ============ -->
	<section id="tour" class="sd-tour">
		<div class="sd-section-head">
			<div class="sd-kicker">Guided tour</div>
			<h2 class="sd-h2">Learn by watching real events arrive.</h2>
			<p class="sd-section-lede">
				The tour advances step-by-step as actual workflow events land — not on button clicks. Here's
				the path from your first order to durable recovery.
			</p>
		</div>
		<div class="sd-timeline">
			<div class="sd-timeline__rail"></div>
			<div class="sd-timeline__steps">
				{#each tour as step (step.n)}
					<div class="sd-step">
						<span class="sd-step__n">{step.n}</span>
						<div class="sd-step__body">
							<div class="sd-step__heading">
								<span class="sd-step__title">{step.title}</span>
								{#if step.control}
									<code class="sd-step__control">{step.control}</code>
								{/if}
							</div>
							<p class="sd-step__text">{step.body}</p>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<!-- ============ GET STARTED / TOKEN ============ -->
	<section id="get-started" class="sd-band sd-start">
		<div class="sd-start__inner">
			<div class="sd-start__grid">
				<div>
					<div class="sd-kicker">Get started</div>
					<h2 class="sd-h2 sd-h2--tight">Enter your demo token to boot a sandbox.</h2>
					<ol class="sd-steps-list">
						<li><span>1.</span> Paste the shared invite code — the demo token.</li>
						<li><span>2.</span> A Firecracker MicroVM boots with Temporal and a worker.</li>
						<li>
							<span>3.</span> Start ordering, then break things — the session self-destructs after ~5
							minutes.
						</li>
					</ol>
				</div>
				<div class="sd-start__card">
					<form class="sd-start__form" onsubmit={startSession}>
						{#if provisionError}
							<Alert variant="danger">{provisionError}</Alert>
						{/if}
						<Input
							id="demo-token"
							label="Demo token"
							type="password"
							autocomplete="off"
							bind:value={demoToken}
							disabled={provisioning}
							placeholder="Enter demo token"
						/>
						<Button
							type="submit"
							variant="primary"
							size="lg"
							fullWidth
							loading={provisioning}
							disabled={startDisabled}
							aria-busy={provisioning}
							label={provisioning ? 'Provisioning sandbox…' : 'New Session'}
						/>
						<p class="sd-start__hint">
							No account needed. Don't have a token? Ask whoever shared Sandman with you.
						</p>
					</form>
				</div>
			</div>
		</div>
	</section>

	<!-- ============ FAQ ============ -->
	<section id="faq" class="sd-faq">
		<h2 class="sd-h2 sd-h2--center">Frequently asked</h2>
		<div class="sd-faq__list">
			{#each faqs as faq (faq.q)}
				<details class="sd-faq__item">
					<summary>
						{faq.q}
						<svg viewBox="0 0 24 24" class="sd-svg sd-faq__chevron"><path d="m6 9 6 6 6-6" /></svg>
					</summary>
					<p>{faq.a}</p>
				</details>
			{/each}
		</div>
	</section>

	<!-- ============ FOOTER CTA ============ -->
	<section class="sd-final">
		<div class="sd-final__inner">
			<h2 class="sd-h2">See durability for yourself.</h2>
			<p class="sd-final__lede">
				Boot a sandbox, start an order, and kill the worker mid-flight. It comes back.
			</p>
			<Button
				variant="primary"
				size="lg"
				onclick={scrollToStart}
				trailingIcon={arrowRight}
				label="Start a session"
			/>
		</div>
	</section>

	<footer class="sd-footer">
		<div class="sd-footer__inner">
			<span class="sd-footer__tag">Ephemeral Temporal sandboxes in the browser</span>
			<div class="sd-footer__links">
				<a href="https://github.com/stevekinney/sandman">GitHub</a>
				<a href="https://temporal.io">Temporal</a>
				<a href="https://e2b.dev">E2B</a>
			</div>
		</div>
	</footer>
</div>

<style>
	/* Smooth in-page anchor jumps, scoped to the splash via :has so other routes
	   keep their default scrolling behavior. */
	:global(html:has(.sandman-splash)) {
		scroll-behavior: smooth;
	}

	.sandman-splash {
		min-height: 100vh;
		background: var(--cinder-bg);
		color: var(--cinder-text);
		font-family: var(--cinder-font-sans, system-ui, sans-serif);
		-webkit-font-smoothing: antialiased;
	}

	.sd-svg {
		width: 1.25em;
		height: 1.25em;
		flex: none;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.sd-dot {
		display: inline-block;
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		flex: none;
	}
	.sd-dot--success {
		background: var(--cinder-success);
	}
	.sd-dot--danger {
		background: var(--cinder-danger);
	}
	.sd-dot--warning {
		background: var(--cinder-warning);
	}
	.sd-dot--info {
		background: var(--cinder-info);
	}

	/* ---------------- NAV ---------------- */
	.sd-nav {
		position: sticky;
		top: 0;
		z-index: 50;
		backdrop-filter: blur(8px);
		background: color-mix(in oklch, var(--cinder-bg) 82%, transparent);
		border-bottom: 1px solid var(--cinder-border-muted);
	}
	.sd-nav__inner {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--cinder-space-3) var(--cinder-space-6);
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--cinder-space-3) var(--cinder-space-6);
	}
	.sd-brand {
		display: flex;
		align-items: center;
		gap: var(--cinder-space-2);
		text-decoration: none;
		color: var(--cinder-text);
	}
	.sd-brand__mark {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-accent);
		color: var(--cinder-accent-contrast);
	}
	.sd-nav__links {
		display: none;
		gap: var(--cinder-space-5);
		margin-left: var(--cinder-space-4);
	}
	.sd-nav__links a {
		color: var(--cinder-text-muted);
		text-decoration: none;
		font-size: 0.875rem;
	}
	.sd-nav__actions {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: var(--cinder-space-2);
	}
	@media (min-width: 48rem) {
		.sd-nav__links {
			display: flex;
		}
	}

	/* ---------------- HERO ---------------- */
	.sd-hero {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6) var(--cinder-space-12);
	}
	.sd-hero__grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
		gap: var(--cinder-space-12);
		align-items: center;
	}
	.sd-eyebrow-pill {
		display: inline-flex;
		align-items: center;
		gap: var(--cinder-space-2);
		padding: var(--cinder-space-1) var(--cinder-space-3);
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-full);
		background: var(--cinder-surface);
		font-size: 0.75rem;
		color: var(--cinder-text-muted);
		margin-bottom: var(--cinder-space-5);
	}
	.sd-hero__title {
		font-size: clamp(2.5rem, 5vw, 3.75rem);
		line-height: 1.04;
		letter-spacing: -0.03em;
		font-weight: 700;
		margin: 0 0 var(--cinder-space-5);
		text-wrap: balance;
	}
	.sd-hero__lede {
		font-size: 1.125rem;
		line-height: 1.6;
		color: var(--cinder-text-muted);
		max-width: 34rem;
		margin: 0 0 var(--cinder-space-8);
		text-wrap: pretty;
	}
	.sd-hero__cta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cinder-space-3);
		margin-bottom: var(--cinder-space-8);
	}
	.sd-hero__meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--cinder-space-5);
		color: var(--cinder-text-subtle);
		font-size: 0.8125rem;
	}
	.sd-hero__meta span {
		display: inline-flex;
		align-items: center;
		gap: var(--cinder-space-1-5);
	}

	/* ---------------- PREVIEW MOCK ---------------- */
	.sd-preview {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface-raised);
		box-shadow: var(--cinder-shadow-lg);
		overflow: hidden;
	}
	.sd-preview__bar {
		display: flex;
		align-items: center;
		gap: var(--cinder-space-2);
		padding: var(--cinder-space-2-5) var(--cinder-space-3);
		border-bottom: 1px solid var(--cinder-border-muted);
		background: var(--cinder-surface);
	}
	.sd-preview__bar .sd-dot {
		width: 0.625rem;
		height: 0.625rem;
	}
	.sd-preview__file {
		margin-left: var(--cinder-space-2);
		font-size: 0.6875rem;
		color: var(--cinder-text-subtle);
		font-family: var(--cinder-font-mono, ui-monospace, monospace);
	}
	.sd-preview__body {
		display: grid;
		grid-template-columns: 1.15fr 1fr;
		min-height: 16rem;
	}
	.sd-code {
		padding: var(--cinder-space-3);
		border-right: 1px solid var(--cinder-border-muted);
		background: var(--cinder-surface-inset);
		font-family: var(--cinder-font-mono, ui-monospace, monospace);
		font-size: 0.6875rem;
		line-height: 1.7;
		color: var(--cinder-text-muted);
		overflow: hidden;
	}
	.sd-indent-1 {
		padding-left: 1rem;
	}
	.sd-indent-2 {
		padding-left: 2rem;
	}
	.sd-kw {
		color: var(--cinder-accent-text);
	}
	.sd-comment {
		color: var(--cinder-text-subtle);
	}
	.sd-str {
		color: var(--cinder-success);
	}
	.sd-history {
		display: flex;
		flex-direction: column;
	}
	.sd-history__head {
		padding: var(--cinder-space-2-5) var(--cinder-space-3);
		border-bottom: 1px solid var(--cinder-border-muted);
		font-size: 0.6875rem;
		color: var(--cinder-text-subtle);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.sd-history__list {
		padding: var(--cinder-space-2) var(--cinder-space-3);
		display: flex;
		flex-direction: column;
		gap: var(--cinder-space-1-5);
		font-size: 0.6875rem;
		font-family: var(--cinder-font-mono, ui-monospace, monospace);
	}
	.sd-history__list > div {
		display: flex;
		gap: var(--cinder-space-2);
		align-items: center;
		color: var(--cinder-text-muted);
	}
	.sd-history__list .sd-dot {
		width: 0.4rem;
		height: 0.4rem;
	}
	.sd-history__actions {
		margin-top: auto;
		padding: var(--cinder-space-3);
		border-top: 1px solid var(--cinder-border-muted);
		display: flex;
		flex-direction: column;
		gap: var(--cinder-space-2);
	}
	.sd-history__actions .cinder-button {
		justify-content: flex-start;
	}

	/* ---------------- BANDS / SECTION HEADS ---------------- */
	.sd-band {
		background: var(--cinder-surface);
		border-top: 1px solid var(--cinder-border-muted);
		border-bottom: 1px solid var(--cinder-border-muted);
	}
	.sd-band__inner {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6);
	}
	.sd-band__inner--narrow {
		max-width: 60rem;
	}
	.sd-wide {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6);
	}
	.sd-section-head {
		margin-bottom: var(--cinder-space-10);
		max-width: 42rem;
	}
	.sd-section-head--center {
		text-align: center;
		max-width: none;
		margin-left: auto;
		margin-right: auto;
	}
	.sd-kicker {
		font-size: 0.75rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--cinder-accent-text);
		font-weight: 600;
		margin-bottom: var(--cinder-space-3);
	}
	.sd-h2 {
		font-size: clamp(1.75rem, 3.5vw, 2.5rem);
		letter-spacing: -0.02em;
		font-weight: 700;
		margin: 0 0 var(--cinder-space-3);
		text-wrap: balance;
	}
	.sd-h2--tight {
		margin-bottom: var(--cinder-space-4);
		font-size: clamp(1.75rem, 3.5vw, 2.25rem);
	}
	.sd-h2--center {
		text-align: center;
		margin-bottom: var(--cinder-space-8);
	}
	.sd-section-lede {
		color: var(--cinder-text-muted);
		font-size: 1.0625rem;
		line-height: 1.6;
		margin: 0;
		text-wrap: pretty;
	}
	.sd-section-lede--center {
		max-width: 38rem;
		margin: 0 auto;
	}

	/* ---------------- DIAGRAM ---------------- */
	.sd-diagram {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface-raised);
		box-shadow: var(--cinder-shadow-md);
		padding: var(--cinder-space-8) var(--cinder-space-6) var(--cinder-space-6);
	}
	.sd-diagram__worker-row {
		display: flex;
		justify-content: center;
		margin-bottom: var(--cinder-space-2);
	}
	.sd-worker {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--cinder-space-3);
		padding: var(--cinder-space-4) var(--cinder-space-6);
		border-radius: var(--cinder-radius-lg);
		border: 1.5px solid var(--cinder-color-success-border);
		background: var(--cinder-color-success-bg);
		animation: sd-worker-state 9s linear infinite;
	}
	.sd-worker__fade {
		display: flex;
		align-items: center;
		gap: var(--cinder-space-3);
		animation: sd-worker-fade 9s linear infinite;
	}
	.sd-worker__pulse {
		width: 0.75rem;
		height: 0.75rem;
		border-radius: 50%;
		background: var(--cinder-success);
		animation: sd-heartbeat 9s linear infinite;
	}
	.sd-worker__title {
		font-weight: 600;
		font-size: 0.9375rem;
	}
	.sd-worker__sub {
		font-size: 0.75rem;
		color: var(--cinder-text-subtle);
		font-family: var(--cinder-font-mono, ui-monospace, monospace);
	}
	.sd-worker__kill {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--cinder-danger);
		animation: sd-kill-mark 9s linear infinite;
	}
	.sd-connector {
		display: flex;
		justify-content: center;
		color: var(--cinder-border-strong);
	}
	.sd-connector__svg {
		width: 1.5rem;
		height: 2.5rem;
		stroke: currentColor;
		fill: none;
		stroke-width: 1.5;
		stroke-linecap: round;
	}
	.sd-progress {
		margin-bottom: var(--cinder-space-6);
	}
	.sd-progress__labels {
		display: flex;
		justify-content: space-between;
		font-size: 0.6875rem;
		color: var(--cinder-text-subtle);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: var(--cinder-space-2);
	}
	.sd-progress__track {
		position: relative;
		height: 0.75rem;
		border-radius: var(--cinder-radius-full);
		background: var(--cinder-surface-inset);
		overflow: hidden;
		border: 1px solid var(--cinder-border-muted);
	}
	.sd-progress__fill {
		position: absolute;
		inset: 0 auto 0 0;
		background: var(--cinder-accent);
		border-radius: var(--cinder-radius-full);
		animation: sd-progress 9s linear infinite;
	}
	.sd-server {
		display: flex;
		align-items: center;
		gap: var(--cinder-space-3);
		padding: var(--cinder-space-4) var(--cinder-space-6);
		border-radius: var(--cinder-radius-lg);
		border: 1px solid var(--cinder-border);
		background: var(--cinder-surface);
		animation: sd-server-emph 9s linear infinite;
	}
	.sd-server__icon {
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-accent);
		color: var(--cinder-accent-contrast);
		flex: none;
	}
	.sd-server__text {
		flex: 1;
	}
	.sd-server__title {
		font-weight: 600;
		font-size: 0.9375rem;
	}
	.sd-server__sub {
		font-size: 0.8125rem;
		color: var(--cinder-text-muted);
	}
	.sd-phases {
		margin-top: var(--cinder-space-6);
		border-top: 1px solid var(--cinder-border-muted);
		padding-top: var(--cinder-space-5);
	}
	.sd-phase {
		display: flex;
		gap: var(--cinder-space-3);
		align-items: flex-start;
		padding: var(--cinder-space-2) 0;
	}
	.sd-phase__n {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		flex: none;
		font-size: 0.75rem;
		font-weight: 600;
		background: var(--cinder-surface-inset);
		color: var(--cinder-accent-text);
		border: 1px solid var(--cinder-border-muted);
	}
	.sd-phase__title {
		font-weight: 600;
		font-size: 0.9375rem;
	}
	.sd-phase__body {
		color: var(--cinder-text-muted);
		font-size: 0.9375rem;
	}

	/* ---------------- SURFACES ---------------- */
	.sd-surfaces {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr));
		gap: var(--cinder-space-5);
	}
	.sd-card {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		padding: var(--cinder-space-6);
		box-shadow: var(--cinder-shadow-sm);
	}
	.sd-card__icon {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: var(--cinder-radius-md);
		background: var(--cinder-surface-inset);
		color: var(--cinder-accent-text);
		flex: none;
	}
	.sd-card__icon--lg {
		width: 2.5rem;
		height: 2.5rem;
		margin-bottom: var(--cinder-space-4);
	}
	.sd-card__title {
		font-size: 1.0625rem;
		font-weight: 600;
		margin: 0 0 var(--cinder-space-2);
	}
	.sd-card__body {
		color: var(--cinder-text-muted);
		font-size: 0.9375rem;
		line-height: 1.6;
		margin: 0;
		text-wrap: pretty;
	}

	/* ---------------- CONCEPTS ---------------- */
	.sd-concepts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 17rem), 1fr));
		gap: var(--cinder-space-4);
	}
	.sd-concept {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface-raised);
		padding: var(--cinder-space-5);
	}
	.sd-concept__head {
		display: flex;
		align-items: center;
		gap: var(--cinder-space-3);
		margin-bottom: var(--cinder-space-2-5);
	}
	.sd-concept__title {
		font-size: 0.9375rem;
		font-weight: 600;
		margin: 0;
	}
	.sd-concept__body {
		color: var(--cinder-text-muted);
		font-size: 0.875rem;
		line-height: 1.55;
		margin: 0;
		text-wrap: pretty;
	}

	/* ---------------- TOUR ---------------- */
	.sd-tour {
		max-width: 60rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6);
	}
	.sd-timeline {
		position: relative;
	}
	.sd-timeline__rail {
		position: absolute;
		left: 0.9375rem;
		top: 0.5rem;
		bottom: 0.5rem;
		width: 2px;
		background: var(--cinder-border-muted);
	}
	.sd-timeline__steps {
		display: flex;
		flex-direction: column;
		gap: var(--cinder-space-1);
	}
	.sd-step {
		position: relative;
		display: flex;
		gap: var(--cinder-space-4);
		align-items: flex-start;
		padding: var(--cinder-space-3) 0;
	}
	.sd-step__n {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		flex: none;
		font-size: 0.8125rem;
		font-weight: 600;
		background: var(--cinder-surface-raised);
		color: var(--cinder-accent-text);
		border: 1.5px solid var(--cinder-border);
	}
	.sd-step__body {
		padding-top: 0.1875rem;
	}
	.sd-step__heading {
		display: flex;
		align-items: center;
		gap: var(--cinder-space-2);
		flex-wrap: wrap;
	}
	.sd-step__title {
		font-weight: 600;
		font-size: 0.9375rem;
	}
	.sd-step__control {
		font-size: 0.75rem;
		font-family: var(--cinder-font-mono, ui-monospace, monospace);
		color: var(--cinder-accent-text);
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		border-radius: var(--cinder-radius-sm);
		padding: 0.0625rem 0.375rem;
	}
	.sd-step__text {
		color: var(--cinder-text-muted);
		font-size: 0.9375rem;
		line-height: 1.55;
		margin: var(--cinder-space-1) 0 0;
		text-wrap: pretty;
	}

	/* ---------------- GET STARTED ---------------- */
	.sd-start {
		scroll-margin-top: 5rem;
		border-bottom: none;
	}
	.sd-start__inner {
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6);
	}
	.sd-start__grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
		gap: var(--cinder-space-10);
		align-items: center;
	}
	.sd-steps-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: var(--cinder-space-3);
	}
	.sd-steps-list li {
		display: flex;
		gap: var(--cinder-space-3);
		align-items: flex-start;
		color: var(--cinder-text-muted);
		font-size: 0.9375rem;
	}
	.sd-steps-list li span {
		color: var(--cinder-accent-text);
		font-weight: 700;
	}
	.sd-start__card {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface-raised);
		box-shadow: var(--cinder-shadow-md);
		padding: var(--cinder-space-6);
	}
	.sd-start__form {
		display: flex;
		flex-direction: column;
		gap: var(--cinder-space-4);
	}
	.sd-start__hint {
		margin: 0;
		font-size: 0.75rem;
		color: var(--cinder-text-subtle);
		text-align: center;
	}

	/* ---------------- FAQ ---------------- */
	.sd-faq {
		max-width: 52rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6);
	}
	.sd-faq__list {
		display: flex;
		flex-direction: column;
		gap: var(--cinder-space-2);
	}
	.sd-faq__item {
		border: 1px solid var(--cinder-border);
		border-radius: var(--cinder-radius-lg);
		background: var(--cinder-surface);
		padding: var(--cinder-space-4) var(--cinder-space-5);
	}
	.sd-faq__item summary {
		cursor: pointer;
		font-weight: 600;
		font-size: 0.9375rem;
		list-style: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--cinder-space-3);
	}
	.sd-faq__item summary::-webkit-details-marker {
		display: none;
	}
	.sd-faq__chevron {
		flex: none;
		transition: transform 0.2s ease;
	}
	.sd-faq__item[open] .sd-faq__chevron {
		transform: rotate(180deg);
	}
	.sd-faq__item p {
		color: var(--cinder-text-muted);
		font-size: 0.9375rem;
		line-height: 1.6;
		margin: var(--cinder-space-3) 0 0;
		text-wrap: pretty;
	}

	/* ---------------- FINAL CTA + FOOTER ---------------- */
	.sd-final {
		background: var(--cinder-surface-inset);
		border-top: 1px solid var(--cinder-border-muted);
	}
	.sd-final__inner {
		max-width: 60rem;
		margin: 0 auto;
		padding: var(--cinder-space-16) var(--cinder-space-6);
		text-align: center;
	}
	.sd-final__lede {
		color: var(--cinder-text-muted);
		font-size: 1.0625rem;
		margin: 0 auto var(--cinder-space-8);
		max-width: 32rem;
		line-height: 1.6;
		text-wrap: pretty;
	}
	.sd-footer {
		border-top: 1px solid var(--cinder-border-muted);
		background: var(--cinder-bg);
	}
	.sd-footer__inner {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--cinder-space-8) var(--cinder-space-6);
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--cinder-space-4);
		justify-content: space-between;
	}
	.sd-footer__tag {
		color: var(--cinder-text-subtle);
		font-size: 0.8125rem;
	}
	.sd-footer__links {
		display: flex;
		gap: var(--cinder-space-5);
		font-size: 0.8125rem;
	}
	.sd-footer__links a {
		color: var(--cinder-text-muted);
		text-decoration: none;
	}

	/* ---------------- ANIMATIONS ----------------
	   Declared -global- so the inline/class `animation:` references resolve.
	   Svelte scopes non-global @keyframes names but does NOT rewrite the
	   references, which would silently break the diagram. */
	@keyframes -global-sd-worker-state {
		0%,
		22% {
			border-color: var(--cinder-color-success-border);
			background: var(--cinder-color-success-bg);
		}
		25%,
		72% {
			border-color: var(--cinder-color-danger-border);
			background: var(--cinder-color-danger-bg);
		}
		75%,
		100% {
			border-color: var(--cinder-color-success-border);
			background: var(--cinder-color-success-bg);
		}
	}
	@keyframes -global-sd-worker-fade {
		0%,
		22% {
			opacity: 1;
		}
		26%,
		71% {
			opacity: 0.42;
		}
		75%,
		100% {
			opacity: 1;
		}
	}
	@keyframes -global-sd-kill-mark {
		0%,
		23% {
			opacity: 0;
			transform: scale(0.6);
		}
		27%,
		71% {
			opacity: 1;
			transform: scale(1);
		}
		75%,
		100% {
			opacity: 0;
			transform: scale(0.6);
		}
	}
	@keyframes -global-sd-heartbeat {
		0%,
		22%,
		75%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		35%,
		65% {
			opacity: 0.3;
			transform: scale(0.85);
		}
	}
	@keyframes -global-sd-progress {
		0% {
			width: 8%;
		}
		22% {
			width: 42%;
		}
		72% {
			width: 42%;
		}
		100% {
			width: 92%;
		}
	}
	@keyframes -global-sd-server-emph {
		0%,
		45% {
			box-shadow: 0 0 0 0 transparent;
			border-color: var(--cinder-border);
		}
		55%,
		72% {
			box-shadow: 0 0 0 3px color-mix(in oklch, var(--cinder-accent) 30%, transparent);
			border-color: var(--cinder-accent);
		}
		82%,
		100% {
			box-shadow: 0 0 0 0 transparent;
			border-color: var(--cinder-border);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(html:has(.sandman-splash)) {
			scroll-behavior: auto;
		}
		.sd-anim {
			animation: none !important;
		}
	}
</style>
