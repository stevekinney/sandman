import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const deploymentWorkflow = readFileSync('.github/workflows/deploy-production.yml', 'utf8');
const packageManifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
	devDependencies?: Record<string, string>;
};

describe('production deployment workflow', () => {
	it('uses the real E2B CLI package instead of the SDK package name', () => {
		expect(packageManifest.devDependencies).toHaveProperty('@e2b/cli');
		expect(deploymentWorkflow).toContain('bun e2b template list --format json');
		expect(deploymentWorkflow).toContain('bun e2b template publish sandman --yes');
		expect(deploymentWorkflow).not.toContain('bunx e2b');
	});
});
