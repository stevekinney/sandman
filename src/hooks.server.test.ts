import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/logging', () => ({
	logError: vi.fn()
}));

vi.mock('$lib/server/sandbox/registry', () => ({
	getSandboxRegistry: vi.fn()
}));

import { handleError } from './hooks.server';
import { logError } from '$lib/server/logging';

describe('handleError', () => {
	it('logs the real error and returns a friendly message instead of leaking internals', () => {
		const err = new Error('password authentication failed for user "neondb_owner"');
		const event = { url: new URL('http://localhost/api/sandbox') };

		const result = handleError({
			error: err,
			event,
			status: 500,
			message: 'Internal Error'
		} as Parameters<typeof handleError>[0]);

		expect(result).toEqual({
			message: 'Something went wrong on our end. Please try again in a moment.'
		});
		expect(logError).toHaveBeenCalledWith(
			expect.objectContaining({
				event: 'request.unhandled_error',
				status: '500',
				path: '/api/sandbox',
				error: err
			})
		);
	});
});
