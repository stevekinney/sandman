import { describe, expect, it } from 'vitest';
import {
	createSignedSessionCookieValue,
	hashDemoToken,
	readSignedSessionCookieValue,
	validateDemoToken
} from './session.ts';

describe('session security helpers', () => {
	it('validates a token against its SHA-256 hash', () => {
		const hash = hashDemoToken('demo-token');
		expect(validateDemoToken('demo-token', hash)).toBe(true);
		expect(validateDemoToken('wrong-token', hash)).toBe(false);
	});

	it('round-trips signed session cookies', () => {
		const value = createSignedSessionCookieValue('session-id', 'secret');
		expect(readSignedSessionCookieValue(value, 'secret')).toBe('session-id');
	});

	it('rejects tampered session cookies', () => {
		const value = createSignedSessionCookieValue('session-id', 'secret');
		const tampered = value.replace('session-id', 'other-session');
		expect(readSignedSessionCookieValue(tampered, 'secret')).toBeNull();
	});
});
