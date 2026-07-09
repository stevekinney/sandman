import { expect, test, type Page } from '@playwright/test';

const DEMO_EMAIL = 'visitor@example.com';
const SANDBOX_ID = 'sbx-playwright-flow';

async function mockSessionExchange(
	page: Page
): Promise<{ sessionRequests: Array<{ email: string; token?: string }> }> {
	const sessionRequests: Array<{ email: string; token?: string }> = [];
	await page.route('**/api/session', async (route) => {
		const request = route.request();
		const payload = request.postDataJSON() as { email?: string; token?: string };
		sessionRequests.push({ email: payload.email ?? '', token: payload.token });
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			headers: {
				'set-cookie': 'sandman_session=e2e-session.signature; Path=/; HttpOnly; SameSite=Lax'
			},
			body: JSON.stringify({ ok: true })
		});
	});
	return { sessionRequests };
}

async function mockSandboxCreation(
	page: Page,
	status = 200,
	body: string | Record<string, unknown> = { sandboxId: SANDBOX_ID }
): Promise<void> {
	await page.route('**/api/sandbox', async (route) => {
		await route.fulfill({
			status,
			contentType: status === 200 ? 'application/json' : 'text/plain',
			body: typeof body === 'string' ? body : JSON.stringify(body)
		});
	});
}

async function mockSandboxStatus(
	page: Page,
	sandboxId: string,
	status: string,
	errorMessage: string | null = null
): Promise<void> {
	await page.route(new RegExp(`/api/sandbox/${sandboxId}/status$`), async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status, errorMessage })
		});
	});
}

test('email-only session start provisions a sandbox and redirects to the session page', async ({
	page
}) => {
	const { sessionRequests } = await mockSessionExchange(page);
	await mockSandboxCreation(page);
	await mockSandboxStatus(page, SANDBOX_ID, 'ready');

	// The landing page follows the OS color scheme by default (no stored
	// preference), so pin a dark preference to assert the email input is
	// legibly dark-themed rather than rendering with unstyled light defaults.
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.goto('/');
	const emailInput = page.getByLabel('Email');
	await emailInput.fill(DEMO_EMAIL);

	await expect(page.getByLabel('Invite code')).toHaveCount(0);
	await expect(emailInput).toHaveValue(DEMO_EMAIL);
	const emailInputStyles = await emailInput.evaluate((element) => {
		const styles = getComputedStyle(element);
		return {
			backgroundColor: styles.backgroundColor,
			color: styles.color,
			colorScheme: styles.colorScheme
		};
	});
	expect(emailInputStyles.colorScheme).toContain('dark');
	expect(emailInputStyles.backgroundColor).not.toBe('rgb(255, 255, 255)');
	expect(emailInputStyles.color).not.toBe('rgb(17, 24, 39)');

	await page.getByRole('button', { name: 'New Session' }).click();

	await expect(page).toHaveURL(`/${SANDBOX_ID}`);
	expect(sessionRequests).toEqual([{ email: DEMO_EMAIL, token: undefined }]);
	await expect(page.locator('.session__id')).toContainText(SANDBOX_ID);
	await expect(page.locator('[data-chip="sandbox"]')).toContainText('Ready');

	// Single-screen workbench: journey rail, code view by default, and the
	// Temporal UI reachable through the center view switch.
	await expect(page.locator('[aria-label="Guided journey"]')).toBeVisible();
	await expect(page.locator('#center-panel-code')).toBeVisible();
	await page
		.getByRole('tablist', { name: 'Workbench view' })
		.getByRole('tab', { name: 'Temporal UI' })
		.click();
	await expect(page.locator('#center-panel-temporal')).toBeVisible();
});

test('keyboard users can jump directly to the guided journey', async ({ page }) => {
	const sandboxId = 'sbx-keyboard-a11y';
	await mockSandboxStatus(page, sandboxId, 'ready');

	await page.goto(`/${sandboxId}`);

	const skipLink = page.getByRole('link', { name: 'Skip to guided journey' });
	await expect(skipLink).toBeAttached();
	await page.locator('body').focus();
	await page.keyboard.press('Tab');
	await expect(skipLink).toBeFocused();

	await page.keyboard.press('Enter');
	const guidedJourney = page.locator('#guided-journey');
	await expect(guidedJourney).toBeFocused();

	await expect(page.getByRole('navigation', { name: 'Tour progress' })).toBeVisible();
});

test('pressing Enter in the email field submits the session form', async ({ page }) => {
	const { sessionRequests } = await mockSessionExchange(page);
	await mockSandboxCreation(page);
	await mockSandboxStatus(page, SANDBOX_ID, 'ready');

	await page.goto('/');
	const emailInput = page.getByLabel('Email');
	await emailInput.fill(DEMO_EMAIL);
	await emailInput.press('Enter');

	await expect(page).toHaveURL(`/${SANDBOX_ID}`);
	expect(sessionRequests).toEqual([{ email: DEMO_EMAIL, token: undefined }]);
});

test('configuration failures show a user-facing alert instead of raw server JSON', async ({
	page
}) => {
	await page.route('**/api/session', async (route) => {
		await route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'SANDMAN_SESSION_SECRET is not configured' })
		});
	});

	await page.goto('/');
	await page.getByLabel('Email').fill(DEMO_EMAIL);
	await page.getByRole('button', { name: 'New Session' }).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText('Sandman is not ready to start new sessions right now.');
	await expect(alert).not.toContainText('SANDMAN_SESSION_SECRET');
	await expect(alert).not.toContainText('{"message"');
});

test('database configuration failures show actionable setup copy', async ({ page }) => {
	await page.route('**/api/session', async (route) => {
		await route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'DATABASE_URL is not a valid Postgres connection string' })
		});
	});

	await page.goto('/');
	await page.getByLabel('Email').fill(DEMO_EMAIL);
	await page.getByRole('button', { name: 'New Session' }).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText('Sandman is not ready to start new sessions right now.');
	await expect(alert).not.toContainText('DATABASE_URL');
});

test('sandbox creation failures keep the user on the landing page with the server message', async ({
	page
}) => {
	await mockSessionExchange(page);
	await mockSandboxCreation(
		page,
		429,
		'This visitor has reached the hourly sandbox creation limit'
	);

	await page.goto('/');
	await page.getByLabel('Email').fill(DEMO_EMAIL);
	await page.getByRole('button', { name: 'New Session' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('alert')).toContainText(
		'This visitor has reached the hourly sandbox creation limit'
	);
});

test('sandbox E2B configuration failures show actionable setup copy', async ({ page }) => {
	await mockSessionExchange(page);
	await mockSandboxCreation(page, 503, { message: 'E2B_API_KEY is invalid or missing' });

	await page.goto('/');
	await page.getByLabel('Email').fill(DEMO_EMAIL);
	await page.getByRole('button', { name: 'New Session' }).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText('Sandman is not ready to start new sessions right now.');
	await expect(alert).not.toContainText('E2B_API_KEY');
});

test('bootstrap failure is displayed on the session page', async ({ page }) => {
	await mockSandboxStatus(page, SANDBOX_ID, 'error', 'Temporal server did not become ready');

	await page.goto(`/${SANDBOX_ID}`);

	await expect(page.locator('[data-chip="sandbox"]')).toContainText('Error');
	await expect(page.locator('.session__gate')).toContainText(
		'Temporal server did not become ready'
	);
	await expect(
		page.locator('.session__gate').getByRole('link', { name: 'Start a new session' })
	).toBeVisible();
	await expect(page.locator('.session')).toHaveAttribute('data-unusable', 'true');
});

test('expired and terminated sandboxes show explicit unusable states', async ({ page }) => {
	for (const [status, label, message] of [
		[
			'expired',
			'Expired',
			'This sandbox expired and has been terminated. Start a new session to continue.'
		],
		[
			'terminated',
			'Terminated',
			'This sandbox has been terminated. Start a new session to continue.'
		]
	] as const) {
		const sandboxId = `${SANDBOX_ID}-${status}`;
		await mockSandboxStatus(page, sandboxId, status);

		await page.goto(`/${sandboxId}`);

		await expect(page.locator('[data-chip="sandbox"]')).toContainText(label);
		await expect(page.locator('.session__gate')).toContainText(message);
		await expect(page.locator('.session')).toHaveAttribute('data-unusable', 'true');
	}
});

test('guided tour can be completed through the visible workflow controls', async ({ page }) => {
	const sandboxId = 'sbx-guided-tour-flow';
	let orderId = 'order-not-started';
	let entryIndex = 0;
	const makeEntry = (description: string, status: string) => ({
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, entryIndex++)).toISOString(),
		description,
		status
	});
	// The demo activity and durable timer both settle instantly in the sandbox,
	// so a freshly started order already carries all three entries by the time
	// the first `getStatus` poll lands — mirroring the real worker's behaviour.
	let timeline = [
		makeEntry('Order received', 'RECEIVED'),
		makeEntry('Payment charged', 'RECEIVED'),
		makeEntry('Waiting for restaurant', 'WAITING_FOR_RESTAURANT')
	];

	// Model real process liveness: the status endpoint reports whether the worker
	// is polling, and a restart is only treated as recovered once it flips back
	// online. Kept in sync by the kill/restart route handlers below.
	let workerOnline = true;
	await page.route(new RegExp(`/api/sandbox/${sandboxId}/status$`), async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'ready',
				errorMessage: null,
				processes: { serverOnline: true, workerOnline }
			})
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow`, async (route) => {
		const payload = route.request().postDataJSON() as { orderId: string };
		orderId = payload.orderId;
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			body: JSON.stringify({ workflowId: orderId, runId: 'run-guided-tour' })
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow/signal`, async (route) => {
		const payload = route.request().postDataJSON() as { name: string; workflowId: string };
		if (payload.name === 'restaurantAccepted') {
			timeline = [...timeline, makeEntry('Restaurant accepted', 'PREPARING')];
		}
		if (payload.name === 'deliveryCompleted') {
			timeline = [...timeline, makeEntry('Order delivered', 'DELIVERED')];
		}
		await route.fulfill({ status: 204, body: '' });
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow/query**`, async (route) => {
		const url = new URL(route.request().url());
		const name = url.searchParams.get('name');
		if (name !== 'getStatus') {
			await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: timeline.at(-1)?.status ?? 'RECEIVED',
				orderId,
				items: [{ name: 'Spicy noodles', quantity: 1, priceCents: 1295 }],
				totalCents: 1295,
				paymentAttempts: 1,
				startedAt: timeline[0]?.timestamp ?? new Date(0).toISOString(),
				timeline
			})
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow/list`, async (route) => {
		// Real Temporal only lists workflows that actually exist — mirror that
		// here so the page's reload-restoration poll (which queries this route
		// from the moment the sandbox is ready, before any order is placed)
		// doesn't mistake the placeholder pre-order state for a resumable run
		// and disable "Place order".
		const workflows =
			orderId === 'order-not-started'
				? []
				: [
						{
							workflowId: orderId,
							runId: 'run-guided-tour',
							status: 'Running',
							type: 'orderWorkflow'
						}
					];
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ workflows })
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/worker/kill`, async (route) => {
		workerOnline = false;
		await route.fulfill({ status: 204, body: '' });
	});
	await page.route(`**/api/sandbox/${sandboxId}/worker/restart`, async (route) => {
		// A real restart re-establishes the worker; the status poll then confirms
		// it, which is what advances the durable-recovery tour step.
		workerOnline = true;
		await route.fulfill({ status: 204, body: '' });
	});

	await page.goto(`/${sandboxId}`);
	const toolbar = page.getByRole('group', { name: 'Order lifecycle' });
	const interactions = page.getByRole('group', { name: 'Workflow interactions' });
	const journey = page.locator('[aria-label="Guided journey"]');

	await toolbar.getByRole('button', { name: 'Place order' }).click();
	// Payment charges (an activity) and the restaurant deadline (a durable
	// timer) both settle before the first poll, so the tour lands straight on
	// the signal step.
	await expect(journey.getByRole('heading', { name: 'Send a signal to resume' })).toBeVisible();

	// The execution pointer maps the awaiting-restaurant phase onto the
	// condition() line in workflow.ts and captions it above the editor.
	await expect(page.getByText(/Executing line \d+ — parked on condition\(\)/)).toBeVisible({
		timeout: 15_000
	});

	await toolbar.getByRole('button', { name: 'Restaurant accepted' }).click();
	await expect(journey.getByRole('heading', { name: 'Read state with a query' })).toBeVisible({
		timeout: 15_000
	});

	await interactions.getByRole('button', { name: 'Get status' }).click();
	await expect(
		journey.getByRole('heading', { name: 'Kill the worker — watch it recover' })
	).toBeVisible();

	// The kill/restart control lives on the worker node in the topology strip.
	const topology = page.locator('[aria-label="System topology"]');
	await topology.getByRole('button', { name: 'Kill' }).click();
	// While the worker is dead the execution pointer flips to its paused state.
	await expect(page.getByText(/Paused at line \d+ — worker offline/)).toBeVisible();
	await topology.getByRole('button', { name: 'Restart' }).click();
	await expect(journey.getByRole('heading', { name: 'Finish the delivery' })).toBeVisible();

	await toolbar.getByRole('button', { name: 'Complete delivery' }).click();
	await expect(page.getByText('Tour complete')).toBeVisible({ timeout: 15_000 });

	// The friendly steps lens shows the same durable history.
	await page
		.getByRole('tablist', { name: 'History lens' })
		.getByRole('tab', { name: 'Steps' })
		.click();
	await expect(page.getByLabel('Order timeline').getByText('Order delivered')).toBeVisible();
});
