/**
 * metadata.ts — canonical HTML/OpenGraph metadata for the application.
 *
 * One source of truth shared by the layout (site-wide tags) and the pages
 * (titles/descriptions), so previews on social cards, chat unfurls, and
 * search results never drift from each other.
 */

/** Site name used for og:site_name and title suffixes. */
export const SITE_NAME = 'Sandman';

/** Full home-page title (also the default social-card title). */
export const SITE_TITLE = 'Sandman — Ephemeral Temporal sandboxes in the browser';

/** One-paragraph pitch used for description and social-card tags. */
export const SITE_DESCRIPTION =
	'Start a real food-ordering workflow in a disposable sandbox, watch every durable step unfold in the code and the Temporal UI, then kill the worker mid-flight and see Temporal resume exactly where it left off.';

/** Static OpenGraph card (regenerate with `bun scripts/generate-og-image.ts`). */
export const OG_IMAGE = {
	path: '/og-image.png',
	width: 1200,
	height: 630,
	alt: 'Sandman — ephemeral Temporal sandboxes in the browser, showing the application → Temporal Server → worker topology.'
} as const;

/** Title for live sandbox session pages. */
export const SESSION_TITLE = `Temporal sandbox session · ${SITE_NAME}`;

/** Description for live sandbox session pages (used on shared invite links). */
export const SESSION_DESCRIPTION =
	'A live, disposable Temporal workbench: guided tour, editable workflow code, chaos controls, and the real Temporal Web UI.';
