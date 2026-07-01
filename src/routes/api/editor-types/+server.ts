/**
 * GET /api/editor-types — the Temporal SDK type declarations for Monaco.
 *
 * Serves every `.d.ts` (plus package.json, for module resolution) from the
 * SDK packages the sandbox files import, so the in-browser editor can offer
 * real hover docs, completions, and signature help. `@temporalio/proto` is
 * ~7 MB of generated protobuf types imported only in type position, so it is
 * replaced with a lightweight `any` stub.
 *
 * The file set is read from the server's own installed dependencies (the same
 * versions the sandbox runs) and cached in memory after the first request.
 */
import { json } from '@sveltejs/kit';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import type { EditorTypeFile } from '$lib/contracts/editor-types';
import type { RequestHandler } from './$types';

const SDK_PACKAGES = ['workflow', 'activity', 'common'] as const;

const PROTO_STUB = `/**
 * Lightweight stand-in for @temporalio/proto (~7 MB of generated protobuf
 * types, imported only in type position by the SDK's own declarations).
 */
export declare const temporal: any;
export declare const coresdk: any;
export declare const google: any;
`;

const require = createRequire(import.meta.url);

let cache: EditorTypeFile[] | null = null;

async function collectDeclarationFiles(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectDeclarationFiles(fullPath)));
		} else if (entry.name.endsWith('.d.ts')) {
			files.push(fullPath);
		}
	}
	return files;
}

async function loadEditorTypeFiles(): Promise<EditorTypeFile[]> {
	const files: EditorTypeFile[] = [];

	for (const name of SDK_PACKAGES) {
		const packageJsonPath = require.resolve(`@temporalio/${name}/package.json`);
		const packageRoot = dirname(packageJsonPath);
		files.push({
			path: `node_modules/@temporalio/${name}/package.json`,
			contents: await readFile(packageJsonPath, 'utf8')
		});
		for (const declarationPath of await collectDeclarationFiles(join(packageRoot, 'lib'))) {
			files.push({
				path: `node_modules/@temporalio/${name}/${relative(packageRoot, declarationPath)}`,
				contents: await readFile(declarationPath, 'utf8')
			});
		}
	}

	files.push({
		path: 'node_modules/@temporalio/proto/package.json',
		contents: JSON.stringify({ name: '@temporalio/proto', types: 'lib/index.d.ts' })
	});
	files.push({ path: 'node_modules/@temporalio/proto/lib/index.d.ts', contents: PROTO_STUB });

	return files;
}

export const GET: RequestHandler = async () => {
	cache ??= await loadEditorTypeFiles();
	return json(
		{ files: cache },
		{ headers: { 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' } }
	);
};
