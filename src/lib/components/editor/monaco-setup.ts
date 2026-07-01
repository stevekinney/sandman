/**
 * monaco-setup.ts — one-time Monaco configuration for the sandbox editor:
 * TypeScript compiler defaults, the workbench-matched theme, and loading the
 * Temporal SDK's type declarations so the sandbox files get real IntelliSense.
 */
import type * as Monaco from 'monaco-editor';
import type { EditorTypeFile } from '$lib/contracts/editor-types';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function callMonacoDefaultsMethod(method: unknown, receiver: object, argument: object): void {
	if (typeof method !== 'function') return;
	Reflect.apply(method, receiver, [argument]);
}

function getTypescriptDefaults(monaco: typeof Monaco): Record<string, unknown> | null {
	const maybeTypeScript: unknown = monaco.languages.typescript;
	if (!isRecord(maybeTypeScript)) return null;
	const maybeDefaults = maybeTypeScript.typescriptDefaults;
	return isRecord(maybeDefaults) ? maybeDefaults : null;
}

/** Compiler options + diagnostics for the in-browser TypeScript service. */
export function configureSandboxTypeScript(monaco: typeof Monaco): void {
	const defaults = getTypescriptDefaults(monaco);
	if (defaults === null) return;

	callMonacoDefaultsMethod(defaults.setCompilerOptions, defaults, {
		target: 99,
		module: 99,
		moduleResolution: 2,
		allowImportingTsExtensions: true,
		allowNonTsExtensions: true,
		esModuleInterop: true,
		skipLibCheck: true,
		strict: true,
		noEmit: true
	});

	// The sandbox worker validates package and relative imports against the real
	// install. Monaco only has these in-memory files, so semantic validation
	// produces false module-resolution errors for legitimate sandbox imports.
	callMonacoDefaultsMethod(defaults.setDiagnosticsOptions, defaults, {
		noSemanticValidation: true,
		noSyntaxValidation: false
	});
}

/**
 * Load the Temporal SDK type declarations (served by /api/editor-types) into
 * Monaco's virtual filesystem so imports from `@temporalio/*` resolve and the
 * learner gets hover docs, completions, and signature help for the real SDK.
 *
 * Returns the extra-lib disposables; failures resolve to an empty list — the
 * editor works without IntelliSense rather than breaking.
 */
export async function loadTemporalTypes(monaco: typeof Monaco): Promise<Monaco.IDisposable[]> {
	const defaults = getTypescriptDefaults(monaco);
	if (defaults === null || typeof defaults.addExtraLib !== 'function') return [];

	try {
		const response = await fetch('/api/editor-types');
		if (!response.ok) return [];
		const payload = (await response.json()) as { files: EditorTypeFile[] };
		return payload.files.map((file) =>
			(defaults.addExtraLib as (contents: string, path: string) => Monaco.IDisposable)(
				file.contents,
				`file:///${file.path}`
			)
		);
	} catch {
		return [];
	}
}

/** The workbench-matched dark theme (cinder palette, not stock vs-dark grey). */
export function defineSandmanTheme(monaco: typeof Monaco): void {
	monaco.editor.defineTheme('sandman-dark', {
		base: 'vs-dark',
		inherit: true,
		rules: [
			{ token: 'comment', foreground: '64748b', fontStyle: 'italic' },
			{ token: 'keyword', foreground: 'c084fc' },
			{ token: 'string', foreground: '86efac' },
			{ token: 'number', foreground: 'fbbf24' },
			{ token: 'type.identifier', foreground: '7dd3fc' }
		],
		colors: {
			'editor.background': '#0b0f17',
			'editor.foreground': '#e2e8f0',
			'editor.lineHighlightBackground': '#111827',
			'editorLineNumber.foreground': '#475569',
			'editorLineNumber.activeForeground': '#94a3b8',
			'editorGutter.background': '#0b0f17',
			'editorIndentGuide.background1': '#1f2937',
			'editorWidget.background': '#0f172a',
			'editorWidget.border': '#334155',
			'editorSuggestWidget.background': '#0f172a',
			'editorHoverWidget.background': '#0f172a',
			'scrollbarSlider.background': '#33415566',
			'scrollbarSlider.hoverBackground': '#33415599'
		}
	});
}
