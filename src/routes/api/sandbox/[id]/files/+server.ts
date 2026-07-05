/**
 * +server.ts — POST /api/sandbox/[id]/files
 *
 * Accepts `{ path: string; contents: string }` in the request body,
 * writes the file into the named sandbox, then hot-restarts the worker.
 * Returns the `WorkerStatus` from the restart as JSON.
 *
 * Writes to `shared.ts` are rejected with 403 — that file is read-only.
 *
 * The sandbox client and handle are provided via `configureSandboxResolver`,
 * which Track A must call from `hooks.server.ts` after provisioning.
 */

import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { SandboxClient, SandboxHandle } from '$lib/contracts/sandbox';
import { writeAndRestart } from '$lib/components/editor/write-and-restart';
import { FILE_DESCRIPTORS } from '$lib/components/editor/file-descriptors';
import { assertSameOrigin } from '$lib/server/security/origin';
import { requireOwnedSandbox, touchSessionActivity } from '$lib/server/security/guards';
import { resolveEntry } from '$lib/server/sandbox/registry';

/** Function that resolves a live sandbox client and handle for a given sandbox ID. */
export type SandboxResolver = (
	id: string
) => Promise<{ client: SandboxClient; handle: SandboxHandle }>;

/**
 * Module-level sandbox resolver — injected by Track A via `configureSandboxResolver`.
 * Throws 503 until configured so the server starts cleanly without a real sandbox.
 */
let _resolve: SandboxResolver = async (id: string) => {
	const entry = resolveEntry(id);
	if (!entry) throw new Error(`Sandbox "${id}" is not registered.`);
	return entry;
};

/**
 * Wire up the sandbox client and handle resolver.
 * Call this from `hooks.server.ts` once the SandboxClient is available.
 *
 * The `_` prefix satisfies SvelteKit's `+server.ts` export allow-list
 * (only HTTP verbs and `_`-prefixed names are valid exports).
 */
export function _configureSandboxResolver(resolver: SandboxResolver): void {
	_resolve = resolver;
}

/** Expected JSON body shape for the files POST endpoint. */
type FilesRequestBody = {
	path: string;
	contents: string;
};

function isFilesRequestBody(value: unknown): value is FilesRequestBody {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as Record<string, unknown>).path === 'string' &&
		typeof (value as Record<string, unknown>).contents === 'string'
	);
}

export const POST: RequestHandler = async (event) => {
	const { params, request } = event;
	const { id } = params;
	assertSameOrigin(event);
	await requireOwnedSandbox(event, id);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Request body must be valid JSON');
	}

	if (!isFilesRequestBody(body)) {
		throw error(400, 'Request body must include "path" (string) and "contents" (string)');
	}

	const { path, contents } = body;

	// Allowlist, not denylist: the write target must be one of the known editor
	// files. Otherwise an unknown `path` (e.g. "../worker.ts" or an absolute path)
	// would fall straight through to `session.files.write` inside the sandbox. The
	// Monaco UI only ever sends these names, so enforce that contract server-side.
	const descriptor = FILE_DESCRIPTORS.find((f) => f.name === path);
	if (descriptor === undefined) {
		throw error(400, `File "${path}" is not an editable sandbox file`);
	}
	if (descriptor.readOnly) {
		throw error(403, `File "${path}" is read-only and cannot be modified`);
	}

	await touchSessionActivity(event, id);

	let client: SandboxClient;
	let handle: SandboxHandle;

	try {
		({ client, handle } = await _resolve(id));
	} catch {
		throw error(503, 'Sandbox not available');
	}

	const status = await writeAndRestart(client, handle, { path, contents });

	return json(status);
};
