/**
 * file-descriptors.ts — static description of the files managed by the Monaco editor.
 *
 * Each descriptor carries the file name, Monaco language identifier, starter
 * content, and a readOnly flag. `shared.ts` is always read-only because it
 * contains generated type helpers that the other files import — its contents
 * should never be overwritten by the editor.
 *
 * The initial contents for each file are loaded from the real sandbox-template
 * source files via Vite's `?raw` import so the editor shows exactly the code
 * that runs in the E2B sandbox. The `?raw` suffix makes Vite treat the files
 * as opaque text strings: they are not compiled or type-checked as TypeScript
 * by the app, only embedded as string literals.
 */

import workflowsRaw from '../../../../sandbox-template/workflows.ts?raw';
import signalsRaw from '../../../../sandbox-template/signals.ts?raw';
import activitiesRaw from '../../../../sandbox-template/activities.ts?raw';
import workerRaw from '../../../../sandbox-template/worker.ts?raw';
import sharedRaw from '../../../../sandbox-template/shared.ts?raw';

/** Name of the read-only shared types file. */
export const SHARED_FILE_NAME = 'shared.ts' as const;

/** A single file surfaced in the Monaco multi-file editor. */
export type FileDescriptor = {
	/** File name shown in the tab bar. */
	name: string;
	/** Short teaching label shown above the editor. */
	purpose: string;
	/** Monaco language identifier (e.g. "typescript"). */
	language: string;
	/** Starter content rendered when the file is first loaded. */
	initialContents: string;
	/** When true the Monaco model is created with `readOnly: true`. */
	readOnly: boolean;
};

/**
 * The files surfaced in the Monaco editor.
 * Order matters: the first entry is selected by default.
 */
export const FILE_DESCRIPTORS: FileDescriptor[] = [
	{
		name: 'workflows.ts',
		purpose:
			'Workflow definitions: deterministic orchestration, signals, queries, updates, timers, and child workflow calls.',
		language: 'typescript',
		initialContents: workflowsRaw,
		readOnly: false
	},
	{
		name: 'signals.ts',
		purpose:
			'Signal definitions: the external events this workflow can receive while it is running.',
		language: 'typescript',
		initialContents: signalsRaw,
		readOnly: true
	},
	{
		name: 'activities.ts',
		purpose:
			'Activity implementations: side effects, retries, heartbeats, and cancellation outside the workflow sandbox.',
		language: 'typescript',
		initialContents: activitiesRaw,
		readOnly: false
	},
	{
		name: 'worker.ts',
		purpose:
			'Worker bootstrap: connects to Temporal and polls the task queue for workflow and activity tasks.',
		language: 'typescript',
		initialContents: workerRaw,
		readOnly: false
	},
	{
		name: SHARED_FILE_NAME,
		purpose:
			'Sandbox-local contract mirror: shared types and scenario metadata copied into the E2B template.',
		language: 'typescript',
		initialContents: sharedRaw,
		readOnly: true
	}
];
