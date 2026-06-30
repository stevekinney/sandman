import { expect, test, type Page } from '@playwright/test';

const DEMO_TOKEN = 'playwright-demo-token';
const SANDBOX_ID = 'sbx-playwright-flow';

async function mockSessionExchange(page: Page): Promise<{ tokenRequests: string[] }> {
	const tokenRequests: string[] = [];
	await page.route('**/api/session', async (route) => {
		const request = route.request();
		const payload = request.postDataJSON() as { token?: string };
		tokenRequests.push(payload.token ?? '');
		await route.fulfill({
			status: 201,
			contentType: 'application/json',
			headers: {
				'set-cookie': 'sandman_session=e2e-session.signature; Path=/; HttpOnly; SameSite=Lax'
			},
			body: JSON.stringify({ ok: true })
		});
	});
	return { tokenRequests };
}

async function mockSandboxCreation(
	page: Page,
	status = 200,
	body = { sandboxId: SANDBOX_ID }
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

test('demo token exchange provisions a sandbox and redirects to the session page', async ({
	page
}) => {
	const { tokenRequests } = await mockSessionExchange(page);
	await mockSandboxCreation(page);
	await mockSandboxStatus(page, SANDBOX_ID, 'ready');

	await page.goto('/');
	const tokenInput = page.getByLabel('Demo token');
	await tokenInput.fill(DEMO_TOKEN);

	await expect(tokenInput).toHaveValue(DEMO_TOKEN);
	const tokenInputStyles = await tokenInput.evaluate((element) => {
		const styles = getComputedStyle(element);
		return {
			backgroundColor: styles.backgroundColor,
			color: styles.color,
			colorScheme: styles.colorScheme
		};
	});
	expect(tokenInputStyles.colorScheme).toContain('dark');
	expect(tokenInputStyles.backgroundColor).not.toBe('rgb(255, 255, 255)');
	expect(tokenInputStyles.color).not.toBe('rgb(17, 24, 39)');

	await page.getByRole('button', { name: 'New Session' }).click();

	await expect(page).toHaveURL(`/${SANDBOX_ID}`);
	expect(tokenRequests).toEqual([DEMO_TOKEN]);
	await expect(page.locator('.session-id')).toContainText(SANDBOX_ID);
	await expect(page.locator('.session-status')).toHaveText('Ready');
	await expect(page.locator('[aria-label="Code editor"]')).toBeVisible();
	await expect(page.locator('[aria-label="Temporal Web UI"]')).toBeVisible();
	await expect(page.locator('[aria-label="Control plane and guided tour"]')).toBeVisible();
});

test('pressing Enter in the demo token field submits the session form', async ({ page }) => {
	const { tokenRequests } = await mockSessionExchange(page);
	await mockSandboxCreation(page);
	await mockSandboxStatus(page, SANDBOX_ID, 'ready');

	await page.goto('/');
	const tokenInput = page.getByLabel('Demo token');
	await tokenInput.fill(DEMO_TOKEN);
	await tokenInput.press('Enter');

	await expect(page).toHaveURL(`/${SANDBOX_ID}`);
	expect(tokenRequests).toEqual([DEMO_TOKEN]);
});

test('invalid demo token keeps the user on the landing page with a clear error', async ({
	page
}) => {
	await page.route('**/api/session', async (route) => {
		await route.fulfill({
			status: 401,
			contentType: 'text/plain',
			body: 'Invalid demo token'
		});
	});

	await page.goto('/');
	await page.getByLabel('Demo token').fill('wrong-token');
	await page.getByRole('button', { name: 'New Session' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('alert')).toContainText(
		'That invite code did not work. Check the code and try again.'
	);
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
	await page.getByLabel('Demo token').fill(DEMO_TOKEN);
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
	await page.getByLabel('Demo token').fill(DEMO_TOKEN);
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
		'This demo token has reached its hourly session creation limit'
	);

	await page.goto('/');
	await page.getByLabel('Demo token').fill(DEMO_TOKEN);
	await page.getByRole('button', { name: 'New Session' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('alert')).toContainText(
		'This demo token has reached its hourly session creation limit'
	);
});

test('sandbox E2B configuration failures show actionable setup copy', async ({ page }) => {
	await mockSessionExchange(page);
	await mockSandboxCreation(page, 503, { message: 'E2B_API_KEY is invalid or missing' });

	await page.goto('/');
	await page.getByLabel('Demo token').fill(DEMO_TOKEN);
	await page.getByRole('button', { name: 'New Session' }).click();

	const alert = page.getByRole('alert');
	await expect(alert).toContainText('Sandman is not ready to start new sessions right now.');
	await expect(alert).not.toContainText('E2B_API_KEY');
});

test('bootstrap failure is displayed on the session page', async ({ page }) => {
	await mockSandboxStatus(page, SANDBOX_ID, 'error', 'Temporal server did not become ready');

	await page.goto(`/${SANDBOX_ID}`);

	await expect(page.locator('.session-status')).toHaveText('Error');
	await expect(page.getByRole('alert')).toContainText('Temporal server did not become ready');
	await expect(page.locator('.session-panels')).toHaveAttribute('data-unusable', 'true');
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

		await expect(page.locator('.session-status')).toHaveText(label);
		await expect(page.getByRole('alert')).toContainText(message);
		await expect(page.locator('.session-panels')).toHaveAttribute('data-unusable', 'true');
	}
});

test('guided tour can be completed through the visible workflow controls', async ({ page }) => {
	const sandboxId = 'sbx-guided-tour-flow';
	let orderId = 'order-not-started';
	let nextTimelineIndex = 3;
	const makeEntry = (description: string, status: string, eventType: string) => ({
		index: nextTimelineIndex++,
		timestamp: new Date(Date.UTC(2026, 0, 1, 1, nextTimelineIndex)).toISOString(),
		description,
		status,
		eventType
	});
	let timeline = makeTourTimelineEntries([
		['Workflow execution started', 'CREATED', 'WorkflowExecutionStarted'],
		['Payment charged', 'VALIDATING', 'ActivityTaskCompleted'],
		['Waiting for restaurant', 'AWAITING_RESTAURANT', 'TimerStarted']
	]);

	await mockSandboxStatus(page, sandboxId, 'ready');
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
			timeline = [
				...timeline,
				makeEntry('Restaurant accepted', 'AWAITING_RESTAURANT', 'WorkflowExecutionSignaled')
			];
		}
		if (payload.name === 'foodReady') {
			timeline = [
				...timeline,
				makeEntry('Delivery child workflow started', 'IN_DELIVERY', 'ChildWorkflowExecutionStarted')
			];
		}
		if (payload.name === 'deliveryCompleted' && payload.workflowId === `delivery-${orderId}`) {
			timeline = [
				...timeline,
				makeEntry('Order delivered', 'DELIVERED', 'WorkflowExecutionCompleted')
			];
		}
		await route.fulfill({ status: 204, body: '' });
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow/update`, async (route) => {
		timeline = [
			...timeline,
			makeEntry(
				'Delivery address updated',
				'AWAITING_RESTAURANT',
				'WorkflowExecutionUpdateAccepted'
			)
		];
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				updated: true,
				effectiveAddress: {
					street: '456 Larimer Street',
					city: 'Denver',
					state: 'CO',
					postalCode: '80202'
				}
			})
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow/query**`, async (route) => {
		const url = new URL(route.request().url());
		const name = url.searchParams.get('name');
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				name === 'getTimeline'
					? timeline
					: {
							status: 'IN_DELIVERY',
							businessSnapshot: {
								OrderStatus: 'IN_DELIVERY',
								CustomerTier: 'standard',
								RestaurantId: 'kitchen-44'
							}
						}
			)
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/workflow/visibility**`, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				workflows: [
					{
						workflowId: orderId,
						runId: 'run-guided-tour',
						type: 'orderFoodWorkflow',
						status: 'Running',
						orderStatus: 'IN_DELIVERY',
						customerTier: 'standard',
						restaurantId: 'kitchen-44'
					}
				]
			})
		});
	});
	await page.route(`**/api/sandbox/${sandboxId}/worker/kill`, async (route) => {
		await route.fulfill({ status: 204, body: '' });
	});
	await page.route(`**/api/sandbox/${sandboxId}/worker/restart`, async (route) => {
		await route.fulfill({ status: 204, body: '' });
	});

	await page.goto(`/${sandboxId}`);
	await page.getByRole('button', { name: 'Place Order' }).click();
	await expect(
		page.getByRole('heading', { name: 'Send a signal to resume the workflow' })
	).toBeVisible();

	await page.getByRole('button', { name: 'Restaurant Accepted' }).click();
	await expect(
		page.getByRole('heading', { name: 'Updates with synchronous validators' })
	).toBeVisible();

	await page.getByLabel('New street').fill('456 Larimer Street');
	await page.getByLabel('New city').fill('Denver');
	await page.getByLabel('New state').fill('CO');
	await page.getByLabel('New postal code').fill('80202');
	await page.getByRole('button', { name: 'Update Address' }).click();
	await expect(
		page.getByRole('heading', { name: 'A child workflow handles delivery' })
	).toBeVisible();

	await page.getByRole('button', { name: 'Food Ready' }).click();
	await expect(
		page.getByRole('heading', { name: 'Read the queryable business snapshot' })
	).toBeVisible();

	await page.getByRole('button', { name: 'Get Status' }).click();
	await expect(
		page.getByRole('heading', { name: 'Filter with Temporal Visibility' })
	).toBeVisible();

	await page.getByRole('button', { name: 'List Visibility' }).click();
	await expect(
		page.getByRole('heading', { name: 'Kill the worker — watch it recover' })
	).toBeVisible();

	await page.getByRole('button', { name: 'Kill Worker' }).click();
	await page.getByRole('button', { name: 'Restart Worker' }).click();
	await expect(page.getByRole('heading', { name: 'Complete the delivery workflow' })).toBeVisible();

	await page.getByRole('button', { name: 'Complete Delivery' }).click();
	await expect(page.getByText('Tour complete')).toBeVisible();
	await expect(page.getByLabel('Order timeline').getByText('Order delivered')).toBeVisible();
});

function makeTourTimelineEntries(
	entries: Array<[description: string, status: string, eventType: string]>
) {
	return entries.map(([description, status, eventType], index) => ({
		index,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
		description,
		status,
		eventType
	}));
}
