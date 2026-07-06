/**
 * registry.spec.ts — sandbox registry wiring unit tests.
 *
 * Runs in the "server" vitest project (node environment).
 * `getSandboxRegistry()` is a process-lifetime singleton, so each test resets
 * modules and re-imports to get a fresh instance — otherwise state would leak
 * across tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/configuration', () => ({
	getProductionConfiguration: vi.fn(() => ({
		e2bApiKey: 'test-key',
		e2bTemplateId: undefined,
		sessionTtlMs: 300_000
	}))
}));

vi.mock('$lib/server/database/connection', () => ({
	getDatabase: vi.fn(() => ({}))
}));

vi.mock('$lib/server/database/repository', () => ({
	getExpiredRegisteredSandboxIds: vi.fn().mockResolvedValue([]),
	markSandboxReclaimed: vi.fn().mockResolvedValue(undefined),
	markExpiredSandboxes: vi.fn().mockResolvedValue([]),
	updateSandboxStatus: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$lib/server/logging', () => ({
	logError: vi.fn(),
	logInfo: vi.fn()
}));

vi.mock('./client.ts', () => ({
	createSandboxClient: vi.fn(() => ({
		terminateById: vi.fn().mockResolvedValue(undefined)
	}))
}));

// Capture the deps passed to createReconciler without running its real timers
// or overlap logic — this test is only about what registry.ts wires in.
let capturedReconcilerDeps:
	| { getExpiredSandboxIds: (input: unknown) => Promise<string[]> }
	| undefined;
vi.mock('./reconciler.ts', () => ({
	createReconciler: vi.fn((deps) => {
		capturedReconcilerDeps = deps;
		return { tick: vi.fn().mockResolvedValue(undefined), start: vi.fn(() => vi.fn()) };
	})
}));

vi.mock('./reaper.ts', () => ({
	createReaper: vi.fn(() => ({
		register: vi.fn(),
		unregister: vi.fn(),
		touch: vi.fn(),
		tick: vi.fn(),
		start: vi.fn(() => vi.fn())
	}))
}));

describe('getSandboxRegistry() — reconciler deps wiring', () => {
	beforeEach(() => {
		vi.resetModules();
		capturedReconcilerDeps = undefined;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('excludes sandboxes this process still holds a handle for from the reconciler batch', async () => {
		const { getExpiredRegisteredSandboxIds } = await import('$lib/server/database/repository');
		vi.mocked(getExpiredRegisteredSandboxIds).mockResolvedValue([
			'sbx-orphaned', // no in-memory handle — a previous process's sandbox
			'sbx-bootstrapping' // this process still holds a handle for it
		]);

		const { getSandboxRegistry, registerHandle } = await import('./registry.ts');
		getSandboxRegistry();
		// Register a handle as if provision() had just succeeded and bootstrap is
		// still running — expiresAt (set at reservation time) can lapse before
		// bootstrap finishes, so this sandbox could otherwise show up as "expired"
		// to the reconciler while it's still legitimately in flight.
		registerHandle('sbx-bootstrapping', {
			id: 'sbx-bootstrapping',
			status: 'Provisioning',
			host: () => 'localhost',
			accessToken: ''
		});

		expect(capturedReconcilerDeps).toBeDefined();
		const ids = await capturedReconcilerDeps!.getExpiredSandboxIds({
			now: new Date(),
			limit: 25
		});

		expect(ids).toEqual(['sbx-orphaned']);
	});
});
