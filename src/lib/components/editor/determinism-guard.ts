/**
 * determinism-guard.ts — Monaco diagnostics provider for Temporal workflow determinism.
 *
 * Teaches the *real* Temporal TypeScript determinism model. The TS workflow
 * sandbox injects deterministic replacements for `Date`, `Date.now()`,
 * `Math.random()`, and `setTimeout` (see the SDK's
 * `packages/worker/src/workflow/vm.ts`), so those calls are replay-safe — there is
 * no `workflow.now()` API; you simply use the patched `Date`. This provider
 * therefore annotates them with an *informational* note explaining why they are
 * safe, and reserves *warnings* for calls that genuinely break determinism or
 * durability in a TS workflow: network I/O (`fetch`), Web Crypto randomness
 * (which is NOT patched — use `uuid4()`), non-durable timers, and Node wall-clock.
 *
 * Only applies to `workflows.ts`. Activities are exempt because I/O is the whole
 * point of an activity.
 */

/**
 * Numeric severity values mirroring `monaco.MarkerSeverity` without requiring
 * a runtime Monaco import (Monaco is browser-only).
 */
export const MARKER_SEVERITY = {
	Error: 8,
	Warning: 4,
	Info: 2,
	Hint: 1
} as const;

/** Union of valid marker severity numbers. */
export type MarkerSeverity = (typeof MARKER_SEVERITY)[keyof typeof MARKER_SEVERITY];

/**
 * A Monaco-compatible diagnostic marker.
 * Matches the shape expected by `monaco.editor.setModelMarkers`.
 */
export type DeterminismMarker = {
	/** Human-readable explanation including a short Temporal determinism lesson. */
	message: string;
	/** 1-based line number of the offending token. */
	startLineNumber: number;
	/** 1-based end line number (same as startLineNumber for single-line tokens). */
	endLineNumber: number;
	/** 1-based column where the pattern starts. */
	startColumn: number;
	/** 1-based column immediately after the pattern. */
	endColumn: number;
	/**
	 * Marker severity. `Info` for SDK-patched calls that are replay-safe (shown as
	 * an explanatory note); `Warning` for calls that genuinely break determinism
	 * or durability.
	 */
	severity: MarkerSeverity;
};

/** A workflow-relevant pattern to scan for, with its display name and full hover message. */
type DeterminismPattern = {
	/** Regex used to find the token. Must use the `g` flag. */
	regex: RegExp;
	/** Short name shown in the marker message. */
	name: string;
	/** Severity to attach to the marker. */
	severity: MarkerSeverity;
	/** Full hover message explaining the determinism implication. */
	message: string;
};

/**
 * Workflow-relevant patterns. Each becomes a marker in `workflows.ts`.
 *
 * The first group is replay-SAFE in the TS SDK (the sandbox patches these to be
 * deterministic) and is flagged only at `Info` severity to teach why. The second
 * group genuinely breaks determinism or durability and is flagged at `Warning`.
 */
const DETERMINISM_PATTERNS: DeterminismPattern[] = [
	// --- Replay-safe (SDK-patched) — informational ---------------------------
	{
		regex: /Date\.now\(\)/g,
		name: 'Date.now()',
		severity: MARKER_SEVERITY.Info,
		message:
			'Determinism note: Date.now() is replay-safe inside a Temporal TypeScript workflow — the sandbox replaces Date with a deterministic clock, so it returns the same workflow time on every replay. Use the patched Date directly; for IDs prefer uuid4() from @temporalio/workflow over time-based values.'
	},
	{
		regex: /new Date\(\)/g,
		name: 'new Date()',
		severity: MARKER_SEVERITY.Info,
		message:
			'Determinism note: new Date() is replay-safe here — Temporal injects a deterministic Date into the workflow sandbox, so it yields the workflow current time consistently across replays.'
	},
	{
		regex: /Math\.random\(\)/g,
		name: 'Math.random()',
		severity: MARKER_SEVERITY.Info,
		message:
			'Determinism note: Math.random() is replay-safe inside a Temporal TypeScript workflow — the SDK seeds it deterministically, so it produces the same sequence on replay. (Note: Web Crypto randomness is NOT patched — use uuid4() for IDs.)'
	},
	{
		regex: /\bsetTimeout\s*\(/g,
		name: 'setTimeout()',
		severity: MARKER_SEVERITY.Info,
		message:
			'Determinism note: setTimeout() is patched to be replay-safe in the workflow sandbox, but it is not a *durable* timer — it does not survive worker restarts. Prefer sleep() from @temporalio/workflow for delays that must survive failures.'
	},
	// --- Genuinely unsafe — warnings -----------------------------------------
	{
		regex: /\bfetch\s*\(/g,
		name: 'fetch()',
		severity: MARKER_SEVERITY.Warning,
		message:
			'Determinism warning: direct network I/O breaks workflow determinism — its result is not recorded in history and would differ on replay. Wrap all I/O in an activity; the server replays activities from their recorded return value.'
	},
	{
		regex: /\bcrypto\.randomUUID\s*\(/g,
		name: 'crypto.randomUUID()',
		severity: MARKER_SEVERITY.Warning,
		message:
			'Determinism warning: Web Crypto is NOT patched by the workflow sandbox, so crypto.randomUUID() is non-deterministic on replay. Use uuid4() from @temporalio/workflow instead.'
	},
	{
		regex: /\bcrypto\.getRandomValues\s*\(/g,
		name: 'crypto.getRandomValues()',
		severity: MARKER_SEVERITY.Warning,
		message:
			'Determinism warning: Web Crypto is NOT patched by the workflow sandbox, so crypto.getRandomValues() is non-deterministic on replay. Derive randomness from a seed passed via workflow input, or generate it in an activity.'
	},
	{
		regex: /\bsetInterval\s*\(/g,
		name: 'setInterval()',
		severity: MARKER_SEVERITY.Warning,
		message:
			'Determinism warning: setInterval() is NOT intercepted by the workflow sandbox (unlike setTimeout) — it runs on the real wall-clock and is non-deterministic on replay. Use a loop with sleep() from @temporalio/workflow for periodic work.'
	},
	{
		regex: /\bprocess\.hrtime\b/g,
		name: 'process.hrtime',
		severity: MARKER_SEVERITY.Warning,
		message:
			'Determinism warning: process.hrtime accesses Node wall-clock I/O, which is non-deterministic on replay. Use the patched Date.now() for workflow time, or move timing into an activity.'
	}
];

/**
 * File names whose code runs inside the deterministic workflow sandbox.
 * Activities, worker, and shared files are exempt because I/O and wall-clock
 * access are intentional there.
 */
const WORKFLOW_FILE_NAMES = new Set([
	'workflows.ts',
	'order-workflow.ts',
	'delivery-workflow.ts',
	'definitions.ts'
]);

/** Returns true when `path` refers to a workflow-sandbox file. */
export function isWorkflowFile(path: string): boolean {
	const filename = path.split('/').pop() ?? path;
	return WORKFLOW_FILE_NAMES.has(filename);
}

/**
 * Scans `code` for non-deterministic API calls.
 *
 * Returns an empty array when `path` is not a workflow file — activities and
 * shared files are intentionally exempt.
 *
 * The returned markers are compatible with `monaco.editor.setModelMarkers` and
 * carry a determinism message suitable for Monaco's hover tooltip.
 */
export function getDeterminismMarkers(code: string, path: string): DeterminismMarker[] {
	if (!isWorkflowFile(path)) return [];

	const markers: DeterminismMarker[] = [];
	const lines = code.split('\n');

	for (const { regex, message, severity } of DETERMINISM_PATTERNS) {
		// Reset stateful regex before each pass
		regex.lastIndex = 0;

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex];
			regex.lastIndex = 0;

			let match: RegExpExecArray | null;
			while ((match = regex.exec(line)) !== null) {
				markers.push({
					message,
					startLineNumber: lineIndex + 1,
					endLineNumber: lineIndex + 1,
					startColumn: match.index + 1,
					endColumn: match.index + match[0].length + 1,
					severity
				});
			}
		}
	}

	return markers;
}
