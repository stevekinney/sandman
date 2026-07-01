/**
 * editor-types.ts — contract for the /api/editor-types endpoint, which serves
 * the Temporal SDK's type declarations to the in-browser Monaco editor.
 */

/** One virtual file for Monaco's TypeScript service. */
export type EditorTypeFile = {
	/** Path relative to the virtual filesystem root (no leading slash). */
	path: string;
	/** The file's full contents (a .d.ts or package.json). */
	contents: string;
};
