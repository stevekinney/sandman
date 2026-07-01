/**
 * execution-pointer.ts — pure helpers behind the editor's execution pointer.
 *
 * The workbench maps the live order phase onto the line of workflow code that
 * is executing (or parked) right now. Because the sandbox files are editable,
 * the pointer anchors to a code substring rather than a fixed line number —
 * the anchor is re-resolved against the current buffer, so it follows the
 * code as the learner edits it and disappears gracefully if they delete it.
 */

/** How the pointed-at line should be presented. */
export type ExecutionPointerState = 'running' | 'paused' | 'replaying';

/** A live pointer into the sandbox source. */
export type ExecutionPointer = {
	/** Which sandbox file the anchor lives in (e.g. `workflows.ts`). */
	file: string;
	/** Substring to locate in the file — resolved to a line at render time. */
	anchor: string;
	/** What the pointed-at code is doing, in plain language. */
	label: string;
	/** Running normally, paused (worker down), or replaying history. */
	state: ExecutionPointerState;
};

/** A one-shot request to jump the editor to a code location and flash it. */
export type CodeReveal = {
	file: string;
	anchor: string;
	/** Monotonic counter so repeated reveals of the same anchor re-fire. */
	nonce: number;
};

/**
 * Locate `anchor` in `source` and return its 1-based line number, or null
 * when the anchor no longer exists (e.g. the learner edited it away).
 */
export function findAnchorLine(source: string, anchor: string): number | null {
	const index = source.indexOf(anchor);
	if (index === -1) return null;
	let line = 1;
	for (let i = 0; i < index; i++) {
		if (source.charCodeAt(i) === 10) line++;
	}
	return line;
}

/** Compose the caption shown above the code for a resolved pointer. */
export function executionCaption(
	pointer: ExecutionPointer,
	line: number,
	inActiveFile: boolean
): string {
	const location = inActiveFile ? `line ${line}` : `${pointer.file} line ${line}`;
	switch (pointer.state) {
		case 'paused':
			return `Paused at ${location} — worker offline; state is safe in the Temporal server`;
		case 'replaying':
			return `Replaying history to ${location} — rebuilding workflow state`;
		case 'running':
			return `Executing ${location} — ${pointer.label}`;
	}
	const exhaustive: never = pointer.state;
	return exhaustive;
}

/** Marker glyph for the caption, mirroring the design mock. */
export function executionMarker(state: ExecutionPointerState): string {
	return state === 'running' ? '▶' : state === 'replaying' ? '↻' : '⏸';
}
