import { describe, expect, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import rule from './no-unguarded-db-call.js';

const ruleTester = new RuleTester({
	languageOptions: {
		parser: tseslint.parser,
		ecmaVersion: 2024,
		sourceType: 'module'
	}
});

describe('local/no-unguarded-db-call', () => {
	it('accepts guarded calls and rejects unguarded ones', () => {
		expect(() =>
			ruleTester.run('no-unguarded-db-call', rule, {
				valid: [
					// Repository call wrapped in try/catch.
					`import { getOwnedSandboxStatus } from '$lib/server/database/repository';
					 export async function GET() {
						try { await getOwnedSandboxStatus(db, {}); } catch (e) { throw e; }
					 }`,
					// Cleanup call inside a catch block is exempt (already error-handling).
					`import { markSandboxReservationError } from '$lib/server/database/repository';
					 export async function POST() {
						try { doThing(); } catch (e) { await markSandboxReservationError(db, {}); }
					 }`,
					// A guard helper from a different module must not be flagged.
					`import { requireOwnedSandbox } from '$lib/server/security/guards';
					 export async function GET(event) { await requireOwnedSandbox(event, 'x'); }`,
					// getDatabase() is an excluded connection helper, not a query.
					`import { getDatabase } from '$lib/server/database/connection';
					 export function GET() { return getDatabase(); }`
				],
				invalid: [
					{
						code: `import { getOwnedSandboxStatus } from '$lib/server/database/repository';
						       export async function GET() { return await getOwnedSandboxStatus(db, {}); }`,
						errors: [{ messageId: 'unguarded' }]
					},
					{
						code: `import { getMonitoringSnapshot } from '$lib/server/database/repository';
						       export async function GET() { return await getMonitoringSnapshot(db, {}); }`,
						errors: [{ messageId: 'unguarded' }]
					},
					{
						// A raw .execute() member call is flagged even without a repository import.
						code: `export async function GET() { await db.execute(query); }`,
						errors: [{ messageId: 'unguarded' }]
					}
				]
			})
		).not.toThrow();
	});
});
