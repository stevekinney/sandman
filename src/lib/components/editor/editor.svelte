<script lang="ts">
	/**
	 * editor.svelte — multi-file Monaco editor for Sandman.
	 *
	 * Surfaces four files (workflows.ts, activities.ts, worker.ts, shared.ts)
	 * with tab switching, debounced saves, Cmd/Ctrl+S explicit saves, per-file
	 * determinism markers, and a WorkerStatusStrip fed by the restart response.
	 *
	 * Monaco is loaded lazily in the browser only.
	 */
	import { FILE_DESCRIPTORS, type FileDescriptor } from '$lib/components/editor/file-descriptors';
	import { getDeterminismMarkers } from '$lib/components/editor/determinism-guard';
	import { createDebounce } from '$lib/components/editor/debounce';
	import WorkerStatusStrip from '$lib/components/editor/worker-status-strip.svelte';
	import type { WorkerStatus } from '$lib/contracts/sandbox';
	import type * as Monaco from 'monaco-editor';
	import { SvelteMap } from 'svelte/reactivity';

	type Props = {
		/** The E2B sandbox ID; used to build the /api/sandbox/[id]/files URL. */
		sandboxId: string;
	};

	const { sandboxId }: Props = $props();

	// ---------------------------------------------------------------------------
	// Reactive UI state — drives the template
	// ---------------------------------------------------------------------------

	let activeFile = $state<FileDescriptor>(FILE_DESCRIPTORS[0]);
	let workerStatus = $state<WorkerStatus | null>(null);
	let isLoading = $state(false);
	let editorContainer = $state<HTMLDivElement | undefined>();

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

	// ---------------------------------------------------------------------------
	// Monaco lifecycle — runs once when the container div is available
	// ---------------------------------------------------------------------------

	$effect(() => {
		// Use a native browser check rather than $app/environment (a SvelteKit virtual
		// module that svelte-check cannot resolve via tsc).
		if (typeof document === 'undefined' || !editorContainer) return;
		const container = editorContainer;
		let disposed = false;

		import('monaco-editor').then((monaco) => {
			if (disposed) return;
			_monaco = monaco;

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
				theme: 'vs-dark',
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
		});

		return () => {
			disposed = true;
			_editor?.dispose();
			_editor = undefined;
			for (const model of _models.values()) model.dispose();
			_models.clear();
			for (const d of _debouncers.values()) d.cancel();
			_debouncers.clear();
			_monaco = undefined;
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
</script>

<div class="sandman-editor">
	<div class="editor-tabs" role="tablist" aria-label="Editor files">
		{#each FILE_DESCRIPTORS as descriptor (descriptor.name)}
			<button
				role="tab"
				aria-selected={activeFile.name === descriptor.name}
				class="editor-tab"
				class:active={activeFile.name === descriptor.name}
				class:readonly={descriptor.readOnly}
				onclick={() => {
					activeFile = descriptor;
				}}
				aria-label={descriptor.readOnly ? `${descriptor.name} (read-only)` : descriptor.name}
			>
				{descriptor.name}
				{#if descriptor.readOnly}
					<span class="readonly-badge" aria-hidden="true">read-only</span>
				{/if}
			</button>
		{/each}
	</div>

	{#if isLoading}
		<div class="editor-saving" aria-live="polite" aria-label="Saving file">Saving…</div>
	{/if}

	<div class="editor-container" bind:this={editorContainer}></div>

	<WorkerStatusStrip {workerStatus} />
</div>

<style>
	.sandman-editor {
		display: flex;
		flex-direction: column;
		height: 100%;
		background: #1e1e1e;
		color: #ccc;
	}

	.editor-tabs {
		display: flex;
		gap: 2px;
		padding: 4px 8px 0;
		border-bottom: 1px solid #333;
		flex-shrink: 0;
		overflow-x: auto;
	}

	.editor-tab {
		padding: 6px 12px;
		background: #2d2d2d;
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: 4px 4px 0 0;
		color: #ccc;
		cursor: pointer;
		font-size: 13px;
		font-family: inherit;
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.editor-tab:hover:not(.active) {
		background: #3a3a3a;
		color: #fff;
	}

	.editor-tab.active {
		background: #1e1e1e;
		border-color: #444;
		color: #fff;
	}

	.editor-tab.readonly {
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
		color: #999;
		background: #252525;
		flex-shrink: 0;
	}

	.editor-container {
		flex: 1;
		min-height: 0;
	}
</style>
