#!/usr/bin/env bun

import { spawn } from 'node:child_process';

const APP_NAME = 'sandman';
const REQUIRED_SECRETS = [
	'DATABASE_URL',
	'E2B_API_KEY',
	'E2B_TEMPLATE_ID',
	'SANDMAN_DEMO_TOKEN_SHA256',
	'SANDMAN_SESSION_SECRET'
];
const REQUIRED_GITHUB_SECRETS = ['FLY_API_TOKEN', 'MIGRATION_DATABASE_URL', 'E2B_API_KEY'];
const REQUIRED_GITHUB_VARIABLES = ['FLY_ORG', 'PRODUCTION_WEB_ORIGIN'];

type FlyResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

type CommandResult = FlyResult;

async function flyctl(args: string[]): Promise<FlyResult> {
	return runCommand('flyctl', args);
}

async function gh(args: string[]): Promise<CommandResult> {
	try {
		return await runCommand('gh', args);
	} catch (err) {
		return { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
	}
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
	return await new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';

		proc.stdout.setEncoding('utf8');
		proc.stderr.setEncoding('utf8');
		proc.stdout.on('data', (chunk: string) => {
			stdout += chunk;
		});
		proc.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});
		proc.on('error', reject);
		proc.on('close', (exitCode) => {
			resolve({ exitCode: exitCode ?? 1, stdout, stderr });
		});
	});
}

export function buildNextCommands(appExists: boolean): string[] {
	const commands: string[] = [];
	if (!appExists) commands.push(`flyctl apps create ${APP_NAME}`);
	commands.push('MIGRATION_DATABASE_URL="<direct-neon-url>" bun run db:migrate');
	commands.push('flyctl config validate --config deployment/fly/web.toml');
	commands.push('flyctl deploy . --config deployment/fly/web.toml');
	return commands;
}

export function findMissingNames(output: string, requiredNames: readonly string[]): string[] {
	return requiredNames.filter((name) => !new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(output));
}

async function main(): Promise<void> {
	const auth = await flyctl(['auth', 'whoami']);
	const app = await flyctl(['apps', 'list']);
	const secrets = await flyctl(['secrets', 'list', '-a', APP_NAME]);
	const githubSecrets = await gh(['secret', 'list', '--env', 'production']);
	const githubVariables = await gh(['variable', 'list', '--env', 'production']);
	const appExists = app.stdout.includes(APP_NAME);

	console.log('# Sandman Deploy Status');
	console.log('');
	console.log(
		auth.exitCode === 0 ? `Fly account: ${auth.stdout.trim()}` : 'Fly account: not authenticated'
	);
	console.log(appExists ? `Fly app: ${APP_NAME} exists` : `Fly app: ${APP_NAME} missing`);

	if (secrets.exitCode === 0) {
		const missing = findMissingNames(secrets.stdout, REQUIRED_SECRETS);
		console.log(
			missing.length === 0 ? 'Fly secrets: complete' : `Fly secrets missing: ${missing.join(', ')}`
		);
	} else {
		console.log('Fly secrets: unreadable until the app exists and flyctl is authenticated');
	}

	if (githubSecrets.exitCode === 0) {
		const missing = findMissingNames(githubSecrets.stdout, REQUIRED_GITHUB_SECRETS);
		console.log(
			missing.length === 0
				? 'GitHub production secrets: complete'
				: `GitHub production secrets missing: ${missing.join(', ')}`
		);
	} else {
		console.log('GitHub production secrets: unreadable with gh');
	}

	if (githubVariables.exitCode === 0) {
		const missing = findMissingNames(githubVariables.stdout, REQUIRED_GITHUB_VARIABLES);
		console.log(
			missing.length === 0
				? 'GitHub production variables: complete'
				: `GitHub production variables missing: ${missing.join(', ')}`
		);
		if (!githubVariables.stdout.includes('E2B_TEAM_ID')) {
			console.log('GitHub optional variable missing: E2B_TEAM_ID');
		}
	} else {
		console.log('GitHub production variables: unreadable with gh');
	}

	console.log('');
	console.log('Next commands:');
	for (const command of buildNextCommands(appExists)) console.log(command);
}

if (import.meta.main) await main();
