/**
 * index.ts — public server-only exports for the sandbox lifecycle module.
 *
 * Import these from other server-side modules:
 *   import { createSandboxClient } from '$lib/server/sandbox';
 */

export { createSandboxClient } from './client.ts';
export type { SandboxClientOpts } from './client.ts';
export { TEMPORAL_GRPC_PORT, TEMPORAL_UI_PORT } from './client.ts';
export { createRealE2bAdapter } from './e2b-adapter.ts';
export type {
	E2bAdapter,
	E2bSandboxSession,
	SandboxCommandResult,
	SandboxCommandHandle,
	CommandRunOpts,
	E2bCreateOpts
} from './e2b-adapter.ts';
export { createReaper } from './reaper.ts';
export type { Reaper } from './reaper.ts';
