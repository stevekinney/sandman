<script lang="ts">
	/**
	 * editor.svelte — multi-file Monaco editor for Sandman.
	 *
	 * Surfaces the sandbox template files shown in the editor tab strip.
	 * with tab switching, debounced saves, Cmd/Ctrl+S explicit saves, per-file
	 * determinism markers, and a WorkerStatusStrip fed by the restart response.
	 *
	 * Monaco is loaded lazily in the browser only.
	 */
	import { FILE_DESCRIPTORS } from '$lib/components/editor/file-descriptors';
	import { getDeterminismMarkers } from '$lib/components/editor/determinism-guard';
	import { createDebounce } from '$lib/components/editor/debounce';
	import {
		configureSandboxTypeScript,
		defineSandmanTheme,
		loadTemporalTypes
	} from '$lib/components/editor/monaco-setup';
	import {
		executionCaption,
		executionMarker,
		findAnchorLine,
		type CodeReveal,
		type ExecutionPointer
	} from '$lib/components/editor/execution-pointer';
	import WorkerStatusStrip from '$lib/components/editor/worker-status-strip.svelte';
	import Tab from '@lostgradient/cinder/tab';
	import TabList from '@lostgradient/cinder/tab-list';
	import Tabs from '@lostgradient/cinder/tabs';
	import type { WorkerStatus } from '$lib/contracts/sandbox';
	import type * as Monaco from 'monaco-editor';
	import { SvelteMap } from 'svelte/reactivity';

	type Props = {
		/** The E2B sandbox ID; used to build the /api/sandbox/[id]/files URL. */
		sandboxId: string;
		/** Live pointer to the line of workflow code executing right now. */
		execution?: ExecutionPointer | null;
		/** One-shot request to jump to and flash a code anchor (experiments). */
		reveal?: CodeReveal | null;
	};

	const { sandboxId, execution = null, reveal = null }: Props = $props();

	// ---------------------------------------------------------------------------
	// Reactive UI state — drives the template
	// ---------------------------------------------------------------------------

	let activeFileName = $state(FILE_DESCRIPTORS[0].name);
	const activeFile = $derived(
		FILE_DESCRIPTORS.find((descriptor) => descriptor.name === activeFileName) ?? FILE_DESCRIPTORS[0]
	);
	let workerStatus = $state<WorkerStatus | null>(null);
	let isLoading = $state(false);
	let editorContainer = $state<HTMLDivElement | undefined>();
	/** Bumped when Monaco finishes loading so pointer effects re-run. */
	let monacoReady = $state(false);
	/** Bumped on every keystroke so the execution anchor is re-resolved. */
	let contentRevision = $state(0);
	/** Resolved 1-based line of the current execution pointer, if found. */
	let executionLine = $state<number | null>(null);

	function editorTabId(fileName: string): string {
		return `editor-tab-${fileName}`;
	}

	// ---------------------------------------------------------------------------
	// Imperative Monaco handles — plain variables, no Svelte tracking needed
	// ---------------------------------------------------------------------------

	// Monaco instances are browser-only imperative APIs. The Maps use SvelteMap
	// to satisfy svelte/prefer-svelte-reactivity; they are never iterated in the
	// template so the reactive overhead is negligible.
	let _editor: Monaco.editor.IStandaloneCodeEditor | undefined;
	let _monaco: typeof Monaco | undefined;
	// Maps filename → Monaco model; populated once during setup.
	const _models = new SvelteMap<string, Monaco.editor.ITextModel>();
	// Maps filename → per-file debouncer instance.
	const _debouncers = new SvelteMap<string, ReturnType<typeof createDebounce<SavePayload>>>();

	// ---------------------------------------------------------------------------
	// Save logic
	// ---------------------------------------------------------------------------

	type SavePayload = { path: string; contents: string };

	/** Returns (or lazily creates) a per-file debouncer. */
	function getDebouncerFor(path: string): ReturnType<typeof createDebounce<SavePayload>> {
		if (!_debouncers.has(path)) {
			_debouncers.set(path, createDebounce(saveFile, 750));
		}
		return _debouncers.get(path)!;
	}

	/** POSTs a file payload to the sandbox files route and updates workerStatus. */
	async function saveFile(payload: SavePayload): Promise<void> {
		isLoading = true;
		try {
			const response = await fetch(`/api/sandbox/${sandboxId}/files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (response.ok) {
				workerStatus = (await response.json()) as WorkerStatus;
			}
		} finally {
			isLoading = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Determinism markers helper
	// ---------------------------------------------------------------------------

	function refreshMarkers(path: string, code: string): void {
		if (!_monaco) return;
		const model = _models.get(path);
		if (!model) return;
		const markers = getDeterminismMarkers(code, path);
		_monaco.editor.setModelMarkers(
			model,
			'determinism-guard',
			markers.map((m) => ({ ...m, source: 'Temporal determinism guard' }))
		);
	}

	$effect(() => {
		// Use a native browser check rather than $app/environment (a SvelteKit virtual
		// module that svelte-check cannot resolve via tsc).
		if (typeof document === 'undefined' || !editorContainer) return;
		const container = editorContainer;
		let disposed = false;

		let typeLibDisposables: Monaco.IDisposable[] = [];

		Promise.all([
			import('monaco-editor'),
			import('monaco-editor/esm/vs/language/typescript/monaco.contribution.js')
		]).then(([monaco]) => {
			if (disposed) return;
			_monaco = monaco;
			configureSandboxTypeScript(monaco);
			defineSandmanTheme(monaco);

			// Temporal SDK declarations load in the background — IntelliSense for
			// `@temporalio/*` imports appears as soon as they land.
			void loadTemporalTypes(monaco).then((disposables) => {
				if (disposed) {
					for (const disposable of disposables) disposable.dispose();
					return;
				}
				typeLibDisposables = disposables;
			});

			// Create one model per file descriptor
			for (const descriptor of FILE_DESCRIPTORS) {
				const uri = monaco.Uri.parse(`file:///${descriptor.name}`);
				const existing = monaco.editor.getModel(uri);
				const model =
					existing ??
					monaco.editor.createModel(descriptor.initialContents, descriptor.language, uri);
				_models.set(descriptor.name, model);
			}

			const initialModel = _models.get(FILE_DESCRIPTORS[0].name)!;

			const editor = monaco.editor.create(container, {
				model: initialModel,
				theme: 'sandman-dark',
				automaticLayout: true,
				fontSize: 14,
				minimap: { enabled: false },
				scrollBeyondLastLine: false,
				readOnly: FILE_DESCRIPTORS[0].readOnly
			});
			_editor = editor;

			// Debounced save + determinism markers on each keystroke
			editor.onDidChangeModelContent(() => {
				const model = editor.getModel();
				if (!model || activeFile.readOnly) return;
				const path = activeFile.name;
				const code = model.getValue();
				getDebouncerFor(path).call({ path, contents: code });
				refreshMarkers(path, code);
				contentRevision++;
			});

			// Cmd/Ctrl+S — immediate save, cancels any pending debounce
			editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
				const model = editor.getModel();
				if (!model || activeFile.readOnly) return;
				const path = activeFile.name;
				getDebouncerFor(path).cancel();
				void saveFile({ path, contents: model.getValue() });
			});

			// Seed initial markers for the first file
			refreshMarkers(FILE_DESCRIPTORS[0].name, initialModel.getValue());
			monacoReady = true;
		});

		return () => {
			disposed = true;
			_editor?.dispose();
			_editor = undefined;
			for (const model of _models.values()) model.dispose();
			_models.clear();
			for (const d of _debouncers.values()) d.cancel();
			_debouncers.clear();
			for (const disposable of typeLibDisposables) disposable.dispose();
			typeLibDisposables = [];
			_monaco = undefined;
			monacoReady = false;
		};
	});

	// ---------------------------------------------------------------------------
	// File switching — reacts to activeFile tab selection
	// ---------------------------------------------------------------------------

	$effect(() => {
		const file = activeFile; // tracked dependency
		if (!_editor || !_monaco) return;
		const model = _models.get(file.name);
		if (!model) return;
		_editor.setModel(model);
		_editor.updateOptions({ readOnly: file.readOnly });
		refreshMarkers(file.name, model.getValue());
	});

	// ---------------------------------------------------------------------------
	// Execution pointer — highlight the line the workflow is executing right now
	// ---------------------------------------------------------------------------

	let _executionDecorationIds: string[] = [];
	let _executionModel: Monaco.editor.ITextModel | undefined;
	let _lastRevealedPointer = '';

	$effect(() => {
		const pointer = execution;
		const activeName = activeFileName; // re-run on tab switches
		void contentRevision; // re-resolve the anchor as the learner edits
		if (!monacoReady || !_monaco) return;

		if (_executionModel && !_executionModel.isDisposed()) {
			_executionDecorationIds = _executionModel.deltaDecorations(_executionDecorationIds, []);
		}
		executionLine = null;
		if (pointer === null) return;
		const model = _models.get(pointer.file);
		if (!model) return;
		const line = findAnchorLine(model.getValue(), pointer.anchor);
		if (line === null) return;

		executionLine = line;
		_executionModel = model;
		_executionDecorationIds = model.deltaDecorations(
			[],
			[
				{
					range: new _monaco.Range(line, 1, line, 1),
					options: {
						isWholeLine: true,
						className: pointer.state === 'running' ? 'exec-line' : 'exec-line exec-line--paused',
						linesDecorationsClassName: 'exec-line-gutter'
					}
				}
			]
		);

		// Scroll to the pointer when it moves (not on every keystroke) and only
		// while the learner is looking at the file it lives in.
		const revealKey = `${pointer.file}:${line}:${pointer.state}`;
		if (revealKey !== _lastRevealedPointer && pointer.file === activeName) {
			_lastRevealedPointer = revealKey;
			_editor?.revealLineInCenterIfOutsideViewport(line);
		}
	});

	// One-shot experiment reveal: switch to the file, center the anchor, flash it.
	let _flashHandle: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const request = reveal;
		if (request === null || !monacoReady || !_monaco) return;
		const monaco = _monaco;
		const model = _models.get(request.file);
		if (!model) return;
		const line = findAnchorLine(model.getValue(), request.anchor);
		if (line === null) return;

		activeFileName = request.file;
		// Let the file-switch effect swap the model in before revealing.
		const editor = _editor;
		clearTimeout(_flashHandle);
		_flashHandle = setTimeout(() => {
			editor?.revealLineInCenter(line);
			const flashIds = model.deltaDecorations(
				[],
				[
					{
						range: new monaco.Range(line, 1, line, 1),
						options: { isWholeLine: true, className: 'exec-flash' }
					}
				]
			);
			_flashHandle = setTimeout(() => {
				if (!model.isDisposed()) model.deltaDecorations(flashIds, []);
			}, 1800);
		}, 60);

		return () => clearTimeout(_flashHandle);
	});
</script>

<div class="sandman-editor">
	<div class="editor-tabs">
		<Tabs bind:value={activeFileName}>
			<TabList label="Editor files" class="editor-tab-list">
				{#each FILE_DESCRIPTORS as descriptor (descriptor.name)}
					<Tab
						id={editorTabId(descriptor.name)}
						value={descriptor.name}
						controls="editor-panel"
						class={`editor-tab${descriptor.readOnly ? ' editor-tab--readonly' : ''}`}
					>
						{descriptor.name}
						{#if descriptor.readOnly}
							<span class="readonly-badge" aria-hidden="true">read-only</span>
						{/if}
					</Tab>
				{/each}
			</TabList>
		</Tabs>
	</div>

	{#if isLoading}
		<div class="editor-saving" aria-live="polite" aria-label="Saving file">Saving…</div>
	{/if}

	<div
		id="editor-panel"
		role="tabpanel"
		tabindex="0"
		aria-labelledby={editorTabId(activeFile.name)}
		class="editor-panel"
	>
		<section class="file-purpose" aria-label="Current file purpose">
			<strong>{activeFile.name}</strong>
			<span>{activeFile.purpose}</span>
		</section>

		{#if execution !== null && executionLine !== null}
			<div class={`exec-caption exec-caption--${execution.state}`} role="status" aria-live="polite">
				<span class="exec-caption__marker" aria-hidden="true"
					>{executionMarker(execution.state)}</span
				>
				<span>{executionCaption(execution, executionLine, execution.file === activeFile.name)}</span
				>
			</div>
		{/if}

		<div class="editor-container" bind:this={editorContainer}></div>

		<WorkerStatusStrip {workerStatus} />
	</div>
</div>

<style>
	.sandman-editor {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: var(--cinder-bg, #0b0f17);
		color: var(--cinder-text-muted, #94a3b8);
	}

	.editor-tabs {
		flex-shrink: 0;
	}

	.sandman-editor :global(.editor-tab-list) {
		gap: 2px;
		padding: 4px 8px 0;
		border-bottom-color: var(--cinder-border-muted, #1f2937);
		overflow-x: auto;
	}

	.sandman-editor :global(.editor-tab) {
		background: var(--cinder-surface, #0f172a);
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: 4px 4px 0 0;
		color: var(--cinder-text-muted, #94a3b8);
		cursor: pointer;
		font-size: 13px;
		font-family: inherit;
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.sandman-editor :global(.editor-tab:hover:not([aria-selected='true'])) {
		background: var(--cinder-surface-hover, #17263a);
		color: var(--cinder-text, #e2e8f0);
	}

	.sandman-editor :global(.editor-tab[aria-selected='true']) {
		background: var(--cinder-bg, #0b0f17);
		border-color: var(--cinder-border, #334155);
		color: var(--cinder-text, #f8fafc);
	}

	.sandman-editor :global(.editor-tab--readonly) {
		cursor: default;
		opacity: 0.75;
	}

	.readonly-badge {
		font-size: 10px;
		opacity: 0.5;
		font-style: italic;
	}

	.editor-saving {
		padding: 2px 10px;
		font-size: 11px;
		color: var(--cinder-text-subtle, #64748b);
		background: var(--cinder-surface, #0f172a);
		flex-shrink: 0;
	}

	.editor-panel {
		display: flex;
		flex: 1;
		min-height: 0;
		flex-direction: column;
	}

	.file-purpose {
		display: flex;
		gap: 0.5rem;
		align-items: baseline;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--cinder-border-muted, #1f2937);
		background: var(--cinder-surface, #0f172a);
		color: var(--cinder-text-muted, #94a3b8);
		font-size: 0.78rem;
		line-height: 1.35;
	}

	.file-purpose strong {
		color: var(--cinder-text, #e2e8f0);
		white-space: nowrap;
	}

	.file-purpose span {
		min-width: 0;
		color: var(--cinder-text-muted, #94a3b8);
	}

	.editor-container {
		flex: 1;
		min-height: 0;
	}

	.exec-caption {
		display: flex;
		align-items: center;
		gap: 0.5625rem;
		flex-shrink: 0;
		padding: 0.4rem 1rem;
		font-size: 0.72rem;
		font-weight: 600;
		border-bottom: 1px solid #333;
		background: color-mix(in oklch, var(--cinder-accent, #818cf8), transparent 88%);
		color: var(--cinder-accent-text, #a5b4fc);
	}

	.exec-caption--paused,
	.exec-caption--replaying {
		background: var(--cinder-color-warning-bg, #38290b);
		color: var(--cinder-color-warning-fg, #fbbf24);
	}

	.exec-caption__marker {
		flex: none;
	}

	/* Monaco decoration classes render inside the editor DOM — must be global. */
	.sandman-editor :global(.exec-line) {
		background: color-mix(in oklch, var(--cinder-accent, #818cf8), transparent 84%);
	}

	.sandman-editor :global(.exec-line--paused) {
		background: color-mix(in oklch, var(--cinder-warning, #f59e0b), transparent 82%);
	}

	.sandman-editor :global(.exec-line-gutter) {
		border-left: 3px solid var(--cinder-accent, #818cf8);
	}

	.sandman-editor :global(.exec-flash) {
		background: color-mix(in oklch, var(--cinder-accent, #818cf8), transparent 60%);
		transition: background 0.3s ease;
	}
</style>
