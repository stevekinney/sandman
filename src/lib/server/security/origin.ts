import { error, type RequestEvent } from '@sveltejs/kit';

export function assertSameOrigin(event: RequestEvent): void {
	const origin = event.request.headers.get('origin');
	if (!origin) {
		throw error(403, 'Origin header is required');
	}
	if (origin !== event.url.origin) {
		throw error(403, 'Origin does not match request host');
	}
}
