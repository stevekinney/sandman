type LogLevel = 'info' | 'warn' | 'error';

type LogFields = {
	event: string;
	sandboxId?: string;
	sessionId?: string;
	status?: string;
	durationMs?: number;
	error?: unknown;
	[key: string]: unknown;
};

export function logInfo(fields: LogFields): void {
	writeLog('info', fields);
}

export function logWarning(fields: LogFields): void {
	writeLog('warn', fields);
}

export function logError(fields: LogFields): void {
	writeLog('error', fields);
}

function writeLog(level: LogLevel, fields: LogFields): void {
	const { error, ...rest } = fields;
	const payload = {
		level,
		timestamp: new Date().toISOString(),
		...rest,
		error: error === undefined ? undefined : sanitizeError(error)
	};
	console[level === 'error' ? 'error' : level](JSON.stringify(payload));
}

function sanitizeError(error: unknown): { name: string; message: string } {
	if (error instanceof Error) return { name: error.name, message: error.message };
	return { name: 'Error', message: String(error) };
}
