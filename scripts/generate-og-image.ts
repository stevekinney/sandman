/**
 * generate-og-image.ts — renders static/og-image.png (1200×630).
 *
 * Draws the OpenGraph card with headless Chromium so the image stays in sync
 * with the workbench's design language (cinder dark palette, topology motif).
 *
 * Run with: bun scripts/generate-og-image.ts
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const OUTPUT_PATH = fileURLToPath(new URL('../static/og-image.png', import.meta.url));

const CARD_HTML = `<!doctype html>
<html>
	<head>
		<meta charset="utf-8" />
		<style>
			* { margin: 0; box-sizing: border-box; }
			body {
				width: 1200px;
				height: 630px;
				display: flex;
				flex-direction: column;
				justify-content: space-between;
				padding: 72px 80px 64px;
				background:
					radial-gradient(ellipse 900px 500px at 85% -10%, rgba(129, 140, 248, 0.18), transparent),
					#0b0f17;
				color: #e2e8f0;
				font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
			}
			.eyebrow {
				font-size: 26px;
				font-weight: 700;
				letter-spacing: 0.12em;
				text-transform: uppercase;
				color: #a5b4fc;
			}
			h1 { font-size: 132px; font-weight: 800; letter-spacing: -0.02em; color: #f8fafc; margin-top: 12px; }
			.tagline { font-size: 44px; line-height: 1.3; color: #94a3b8; margin-top: 18px; max-width: 900px; }
			.topology { display: flex; align-items: center; gap: 0; margin-top: 40px; }
			.node {
				display: flex; align-items: center; gap: 14px;
				border: 1px solid #334155; border-radius: 16px;
				background: #111f32; padding: 20px 28px;
				font-size: 28px; font-weight: 700; color: #e2e8f0;
			}
			.node--server { border-color: rgba(129, 140, 248, 0.55); box-shadow: 0 0 0 6px rgba(129, 140, 248, 0.12); }
			.dot { width: 16px; height: 16px; border-radius: 50%; background: #4ade80; }
			.dot--idle { background: #64748b; }
			.link { width: 72px; height: 3px; background: linear-gradient(90deg, #334155, #818cf8, #334155); }
		</style>
	</head>
	<body>
		<div>
			<div class="eyebrow">Ephemeral Temporal sandboxes in the browser</div>
			<h1>Sandman</h1>
			<div class="tagline">
				Run a real durable workflow, kill the worker mid-flight, and watch Temporal
				resume exactly where it left off.
			</div>
		</div>
		<div class="topology">
			<div class="node"><span class="dot dot--idle"></span>Your application</div>
			<div class="link"></div>
			<div class="node node--server"><span class="dot"></span>Temporal Server</div>
			<div class="link"></div>
			<div class="node"><span class="dot"></span>Worker</div>
		</div>
	</body>
</html>`;

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
	await page.setContent(CARD_HTML, { waitUntil: 'networkidle' });
	await page.screenshot({ path: OUTPUT_PATH, type: 'png' });
	console.log(`Wrote ${OUTPUT_PATH}`);
} finally {
	await browser.close();
}
