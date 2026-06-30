const UNUSABLE_SANDBOX_STATUSES = new Set(['error', 'expired', 'terminated']);

export function isSandboxUnusable(status: string): boolean {
	return UNUSABLE_SANDBOX_STATUSES.has(status);
}

export function getSandboxStatusFailureMessage(
	status: string,
	errorMessage: string | null
): string | null {
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
