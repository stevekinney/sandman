import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE_NAME = 'sandman_session';

export type SessionCookieOptions = {
	httpOnly: boolean;
	sameSite: 'lax';
	secure: boolean;
	path: string;
	maxAge: number;
};

export function hashDemoToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export function validateDemoToken(input: string, expectedHash: string | undefined): boolean {
	if (!expectedHash) return false;
	return constantTimeEqualHex(hashDemoToken(input), expectedHash);
}

export function createSignedSessionCookieValue(sessionId: string, secret: string): string {
	return `${sessionId}.${signSessionId(sessionId, secret)}`;
}

export function createSessionCookieOptions(url: URL, ttlMs: number): SessionCookieOptions {
	return {
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		path: '/',
		maxAge: Math.ceil(ttlMs / 1000)
	};
}

export function readSignedSessionCookieValue(
	value: string | undefined,
	secret: string
): string | null {
	if (!value) return null;
	const [sessionId, signature, extra] = value.split('.');
	if (!sessionId || !signature || extra !== undefined) return null;
	const expectedSignature = signSessionId(sessionId, secret);
	if (!constantTimeEqualHex(signature, expectedSignature)) return null;
	return sessionId;
}

function signSessionId(sessionId: string, secret: string): string {
	return createHmac('sha256', secret).update(sessionId).digest('hex');
}

function constantTimeEqualHex(left: string, right: string): boolean {
	if (!isHex(left) || !isHex(right)) return false;
	const leftBuffer = Buffer.from(left, 'hex');
	const rightBuffer = Buffer.from(right, 'hex');
	if (leftBuffer.length !== rightBuffer.length) return false;
	return timingSafeEqual(leftBuffer, rightBuffer);
}

function isHex(value: string): boolean {
	return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
