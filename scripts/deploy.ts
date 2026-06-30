#!/usr/bin/env bun

const APP_NAME = 'sandman';
const REQUIRED_SECRETS = [
	'DATABASE_URL',
	'E2B_API_KEY',
	'E2B_TEMPLATE_ID',
	'SANDMAN_DEMO_TOKEN_SHA256',
	'SANDMAN_SESSION_SECRET'
];

type FlyResult = {
	exitCode: number;
	stdout: string;
	stderr: string;
};

async function flyctl(args: string[]): Promise<FlyResult> {
	const proc = Bun.spawn(['flyctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited
	]);
	return { exitCode, stdout, stderr };
}

async function main(): Promise<void> {
	const auth = await flyctl(['auth', 'whoami']);
	const app = await flyctl(['apps', 'list']);
	const secrets = await flyctl(['secrets', 'list', '-a', APP_NAME]);

	console.log('# Sandman Deploy Status');
	console.log('');
	console.log(
		auth.exitCode === 0 ? `Fly account: ${auth.stdout.trim()}` : 'Fly account: not authenticated'
	);
	console.log(
		app.stdout.includes(APP_NAME) ? `Fly app: ${APP_NAME} exists` : `Fly app: ${APP_NAME} missing`
	);

	if (secrets.exitCode === 0) {
		const missing = REQUIRED_SECRETS.filter((secret) => !secrets.stdout.includes(secret));
		console.log(
			missing.length === 0 ? 'Fly secrets: complete' : `Fly secrets missing: ${missing.join(', ')}`
		);
	} else {
		console.log('Fly secrets: unreadable until the app exists and flyctl is authenticated');
	}

	console.log('');
	console.log('Next commands:');
	if (!app.stdout.includes(APP_NAME)) {
		console.log(`flyctl apps create ${APP_NAME}`);
	}
	console.log('bun run db:migrate');
	console.log('flyctl config validate --config deployment/fly/web.toml');
	console.log(
		'flyctl deploy . --config deployment/fly/web.toml --dockerfile deployment/containers/web.Dockerfile'
	);
}

await main();
