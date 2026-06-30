import { error } from '@sveltejs/kit';
import type { ExecResult } from '$lib/contracts/sandbox';
import { resolveEntry, type SandboxEntry } from './registry.ts';

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export function getTemporalCliTarget(sandboxId: string): SandboxEntry {
	const entry = resolveEntry(sandboxId);
	if (entry === null) {
		throw error(503, 'Live sandbox handle is unavailable for this session');
	}
	return entry;
}

export async function writeTemporalJsonInput(
	entry: SandboxEntry,
	prefix: string,
	value: unknown
): Promise<string> {
	const path = `/tmp/sandman-${prefix}-${crypto.randomUUID()}.json`;
	await entry.client.writeFile(entry.handle, path, JSON.stringify(value));
	return path;
}

export async function runTemporalCommand(
	entry: SandboxEntry,
	command: string,
	timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<ExecResult> {
	return entry.client.exec(entry.handle, `${command} 2>&1`, { timeoutMs });
}

export async function runTemporalJsonCommand(
	entry: SandboxEntry,
	command: string,
	timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS
): Promise<unknown> {
	const result = await runTemporalCommand(entry, command, timeoutMs);
	if (result.exitCode !== 0) {
		throw error(502, getTemporalCommandFailureMessage(result, 'Temporal command failed'));
	}
	return parseTemporalJson(result.stdout);
}

export function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function getTemporalCommandFailureMessage(result: ExecResult, fallback: string): string {
	const output = `${result.stdout}${result.stderr}`.trim();
	return output.length > 0 ? output : fallback;
}

function parseTemporalJson(output: string): unknown {
	try {
		const parsed: unknown = JSON.parse(output);
		return parsed;
	} catch {
		throw error(502, `Temporal command returned invalid JSON: ${output.slice(0, 500)}`);
	}
}
