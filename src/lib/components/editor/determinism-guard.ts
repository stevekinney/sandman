/**
 * determinism-guard.ts — Monaco diagnostics provider for Temporal workflow determinism.
 *
 * Scans workflow source code for non-deterministic API calls (Date.now, Math.random,
 * fetch, etc.) and returns Monaco-compatible markers that appear as hover diagnostics.
 *
 * Only applies to `workflows.ts`. Activities are explicitly exempt because I/O is
 * the whole point of an activity.
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
	/** Marker severity — always Warning for determinism issues. */
	severity: MarkerSeverity;
};

/** A non-deterministic pattern to scan for, with its display name and explanation. */
type NonDeterministicPattern = {
	/** Regex used to find the token. Must use the `g` flag. */
	regex: RegExp;
	/** Short name shown in the marker message. */
	name: string;
	/** One-sentence determinism explanation. */
	explanation: string;
};

/**
 * Patterns that break Temporal workflow determinism.
 * Each entry becomes a Warning marker in the Monaco editor.
 */
const NONDETERMINISTIC_PATTERNS: NonDeterministicPattern[] = [
	{
		regex: /Date\.now\(\)/g,
		name: 'Date.now()',
		explanation:
			'Temporal replays this workflow from history; Date.now() will return a different value on replay. Use workflow.now() for the deterministic current time.'
	},
	{
		regex: /new Date\(\)/g,
		name: 'new Date()',
		explanation:
			'new Date() is non-deterministic during replay. Use workflow.now() and construct a Date from its result.'
	},
	{
		regex: /Math\.random\(\)/g,
		name: 'Math.random()',
		explanation:
			'Math.random() returns different values on each replay. Move randomness into an activity or pass a seed value via workflow input.'
	},
	{
		regex: /\bfetch\s*\(/g,
		name: 'fetch()',
		explanation:
			'Direct network calls break determinism. Wrap all I/O in activities; the Temporal server ensures activities are replayed from their recorded return value.'
	},
	{
		regex: /\bsetTimeout\s*\(/g,
		name: 'setTimeout()',
		explanation:
			'setTimeout is non-deterministic across restarts. Use workflow.sleep() for durable, replayable delays.'
	},
	{
		regex: /\bsetInterval\s*\(/g,
		name: 'setInterval()',
		explanation:
			'setInterval is not safe inside a workflow. Use a loop with workflow.sleep() for periodic work.'
	},
	{
		regex: /\bprocess\.hrtime\b/g,
		name: 'process.hrtime',
		explanation:
			'process.hrtime yields non-deterministic wall-clock values. Use workflow.now() instead.'
	}
];

/**
 * Returns true when `path` refers to the workflow definitions file.
 * Only workflows.ts is subject to determinism checking; activities and shared
 * files are exempt because I/O and wall-clock access are intentional there.
 */
export function isWorkflowFile(path: string): boolean {
	const filename = path.split('/').pop() ?? path;
	return filename === 'workflows.ts';
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

	for (const { regex, name, explanation } of NONDETERMINISTIC_PATTERNS) {
		// Reset stateful regex before each pass
		regex.lastIndex = 0;

		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex];
			regex.lastIndex = 0;

			let match: RegExpExecArray | null;
			while ((match = regex.exec(line)) !== null) {
				markers.push({
					message: `Non-determinism warning: ${name} breaks workflow determinism. ${explanation}`,
					startLineNumber: lineIndex + 1,
					endLineNumber: lineIndex + 1,
					startColumn: match.index + 1,
					endColumn: match.index + match[0].length + 1,
					severity: MARKER_SEVERITY.Warning
				});
			}
		}
	}

	return markers;
}
