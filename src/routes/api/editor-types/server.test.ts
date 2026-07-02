/**
 * server.test.ts — unit tests for GET /api/editor-types.
 * Runs in the "server" vitest project (node environment).
 */
import { describe, expect, it } from 'vitest';
import type { EditorTypeFile } from '$lib/contracts/editor-types';
import { GET } from './+server.ts';

async function fetchFiles(): Promise<EditorTypeFile[]> {
	// The handler ignores the request event entirely; tests pass fast-and-loose.
	const response = await GET({} as never);
	const payload = (await response.json()) as { files: EditorTypeFile[] };
	return payload.files;
}

describe('GET /api/editor-types', () => {
	it('serves the entry declarations and package.json for each SDK package', async () => {
		const files = await fetchFiles();
		const paths = new Set(files.map((file) => file.path));
		for (const name of ['workflow', 'activity', 'common']) {
			expect(paths.has(`node_modules/@temporalio/${name}/package.json`)).toBe(true);
			expect(paths.has(`node_modules/@temporalio/${name}/lib/index.d.ts`)).toBe(true);
		}
	});

	it('serves real declaration content (the workflow API surface)', async () => {
		const files = await fetchFiles();
		const workflowIndex = files.find(
			(file) => file.path === 'node_modules/@temporalio/workflow/lib/index.d.ts'
		);
		expect(workflowIndex).toBeDefined();
		expect(workflowIndex!.contents).toContain('proxyActivities');
	});

	it('replaces @temporalio/proto with a lightweight stub', async () => {
		const files = await fetchFiles();
		const protoStub = files.find(
			(file) => file.path === 'node_modules/@temporalio/proto/lib/index.d.ts'
		);
		expect(protoStub).toBeDefined();
		expect(protoStub!.contents).toContain('export declare const temporal: any;');
		// The stub replaces ~7 MB of generated types — it must stay tiny.
		expect(protoStub!.contents.length).toBeLessThan(1000);
	});

	it('stays a reasonable payload size for a one-time editor fetch', async () => {
		const files = await fetchFiles();
		const totalBytes = files.reduce((sum, file) => sum + file.contents.length, 0);
		expect(totalBytes).toBeGreaterThan(100_000);
		expect(totalBytes).toBeLessThan(1_500_000);
	});

	it('marks the response cacheable', async () => {
		const response = await GET({} as never);
		expect(response.headers.get('cache-control')).toContain('max-age=3600');
	});
});
