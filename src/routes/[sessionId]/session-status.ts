const UNUSABLE_SANDBOX_STATUSES = new Set([
	'authentication-required',
	'error',
	'expired',
	'terminated'
]);

const SANDBOX_STATUS_LABELS = new Map([
	['authentication-required', 'Session required'],
	['bootstrapping', 'Bootstrapping'],
	['error', 'Error'],
	['expired', 'Expired'],
	['provisioning', 'Provisioning'],
	['ready', 'Ready'],
	['terminated', 'Terminated']
]);

const AUTHENTICATION_FAILURE_MESSAGE =
	'This sandbox link needs an active session. Start a new sandbox to continue.';

const READY_SANDBOX_STATUS = 'ready';

const SANDBOX_STARTUP_STEPS = [
	{
		id: 'provisioning',
		label: 'Provision sandbox',
		description: 'Allocating an E2B MicroVM and attaching it to this browser session.'
	},
	{
		id: 'bootstrapping',
		label: 'Start Temporal services',
		description:
			'Installing dependencies, starting Temporal Server, then launching the worker and Web UI.'
	},
	{
		id: 'ready',
		label: 'Ready',
		description: 'The sandbox is ready and the workbench controls are enabled.'
	}
] as const;

const SANDBOX_STARTUP_STATUSES: ReadonlySet<string> = new Set(
	SANDBOX_STARTUP_STEPS.filter((step) => step.id !== READY_SANDBOX_STATUS).map((step) => step.id)
);

export type SandboxStartupStepState = 'complete' | 'current' | 'upcoming';

export type SandboxStartupStep = {
	id: string;
	label: string;
	description: string;
	state: SandboxStartupStepState;
};

export type SandboxStartupProgress = {
	percent: number;
	currentStepNumber: number;
	totalStepCount: number;
	currentStepLabel: string;
	currentStepDescription: string;
	steps: SandboxStartupStep[];
};

export function isSandboxUnusable(status: string): boolean {
	return UNUSABLE_SANDBOX_STATUSES.has(status);
}

export function isSandboxStarting(status: string): boolean {
	return SANDBOX_STARTUP_STATUSES.has(status);
}

export function getSandboxStartupProgress(status: string): SandboxStartupProgress {
	const statusIndex = SANDBOX_STARTUP_STEPS.findIndex((step) => step.id === status);
	const currentIndex = statusIndex === -1 ? 0 : statusIndex;
	const currentStep = SANDBOX_STARTUP_STEPS[currentIndex];
	const totalStepCount = SANDBOX_STARTUP_STEPS.length;

	return {
		percent: Math.ceil(((currentIndex + 1) / totalStepCount) * 100),
		currentStepNumber: currentIndex + 1,
		totalStepCount,
		currentStepLabel: currentStep.label,
		currentStepDescription: currentStep.description,
		steps: SANDBOX_STARTUP_STEPS.map((step, index) => ({
			...step,
			state: getStartupStepState(index, currentIndex)
		}))
	};
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

function getStartupStepState(index: number, currentIndex: number): SandboxStartupStepState {
	if (index < currentIndex) return 'complete';
	if (index === currentIndex) return 'current';
	return 'upcoming';
}
