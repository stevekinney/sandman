const UNUSABLE_SANDBOX_STATUSES = new Set([
	'authentication-required',
	'error',
	'expired',
	'terminated'
]);

const SANDBOX_STATUS_LABELS = new Map([
	['authentication-required', 'Invite required'],
	['bootstrapping', 'Bootstrapping'],
	['error', 'Error'],
	['expired', 'Expired'],
	['provisioning', 'Provisioning'],
	['ready', 'Ready'],
	['terminated', 'Terminated']
]);

const AUTHENTICATION_FAILURE_MESSAGE =
	'This sandbox link needs an active invite session. Enter your invite code to start a new sandbox.';

export function isSandboxUnusable(status: string): boolean {
	return UNUSABLE_SANDBOX_STATUSES.has(status);
}

export function getSandboxStatusFailureMessage(
	status: string,
	errorMessage: string | null
): string | null {
	if (status === 'authentication-required') {
		return AUTHENTICATION_FAILURE_MESSAGE;
	}
	if (status === 'error') {
		return errorMessage ?? 'Sandbox bootstrap failed. Start a new session to try again.';
	}
	if (status === 'expired') {
		return 'This sandbox expired and has been terminated. Start a new session to continue.';
	}
	if (status === 'terminated') {
		return 'This sandbox has been terminated. Start a new session to continue.';
	}
	return errorMessage;
}

export function getSandboxStatusDisplayLabel(status: string): string {
	return SANDBOX_STATUS_LABELS.get(status) ?? status;
}

export function getSandboxStatusResponseFailureMessage(
	statusCode: number,
	responseBody: string
): string {
	if (statusCode === 401) return AUTHENTICATION_FAILURE_MESSAGE;

	const trimmedBody = responseBody.trim();
	if (!trimmedBody) return 'Sandman could not load this sandbox status.';

	try {
		const parsed: unknown = JSON.parse(trimmedBody);
		if (isMessageResponse(parsed)) return parsed.message;
	} catch {
		return trimmedBody;
	}

	return trimmedBody;
}

function isMessageResponse(value: unknown): value is { message: string } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'message' in value &&
		typeof value.message === 'string'
	);
}
