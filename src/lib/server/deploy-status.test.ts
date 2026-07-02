import { describe, expect, it } from 'vitest';
import { buildNextCommands, findMissingNames } from '../../../scripts/deploy';

describe('deploy status helpers', () => {
	it('prints the migration command with MIGRATION_DATABASE_URL', () => {
		expect(buildNextCommands(true)).toContain(
			'MIGRATION_DATABASE_URL="<direct-neon-url>" bun run db:migrate'
		);
		expect(buildNextCommands(true)).toContain('flyctl deploy . --config deployment/fly/web.toml');
		expect(buildNextCommands(true)).not.toContain('bun run db:migrate');
		expect(buildNextCommands(true).join('\n')).not.toContain('--dockerfile');
	});

	it('reports missing GitHub Actions names without requiring values', () => {
		expect(
			findMissingNames('FLY_API_TOKEN\tupdated\nE2B_API_KEY\tupdated\n', [
				'FLY_API_TOKEN',
				'MIGRATION_DATABASE_URL',
				'E2B_API_KEY'
			])
		).toEqual(['MIGRATION_DATABASE_URL']);
	});
});
