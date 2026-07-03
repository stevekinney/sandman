/**
 * splash-content.ts — static presentational content for the landing page.
 *
 * The marketing copy and iconography live here so `+page.svelte` stays focused
 * on layout and behavior. Icons are described as arrays of primitive SVG child
 * descriptors (path/circle/rect/polyline/ellipse) rather than raw markup, so the
 * page can render them through a typed snippet without `{@html}`.
 *
 * This is intentionally separate from the contract-driven teaching data in
 * `$lib/content/demo-script.ts`: that drives the live in-session tour off real
 * workflow events, whereas this is landing-page copy with no runtime coupling.
 */

/** A single drawable child of a 24×24 line icon. */
export type IconPart =
	| { kind: 'path'; d: string }
	| { kind: 'circle'; cx: number; cy: number; r: number }
	| { kind: 'rect'; x: number; y: number; w: number; h: number; rx?: number }
	| { kind: 'polyline'; points: string }
	| { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

/** One caption in the animated kill/recover diagram. */
export type Phase = { n: number; title: string; body: string };

/** One of the three primary workbench surfaces. */
export type Surface = { title: string; body: string; icon: IconPart[] };

/** One Temporal concept exercised by the demo workflow. */
export type Concept = { title: string; body: string; icon: IconPart[] };

/** One step in the guided tour, with an optional control-plane action code. */
export type TourStep = { n: number; title: string; control?: string; body: string };

/** One frequently-asked question and its answer. */
export type Faq = { q: string; a: string };

const path = (d: string): IconPart => ({ kind: 'path', d });
const circle = (cx: number, cy: number, r: number): IconPart => ({ kind: 'circle', cx, cy, r });
const rect = (x: number, y: number, w: number, h: number, rx?: number): IconPart => ({
	kind: 'rect',
	x,
	y,
	w,
	h,
	rx
});

/** Captions under the kill/recover diagram, in playback order. */
export const phases: Phase[] = [
	{
		n: 1,
		title: 'Workflow runs',
		body: 'Each durable step is appended to Temporal’s event history.'
	},
	{
		n: 2,
		title: 'Worker is killed',
		body: 'The Node process dies mid-flight — the code stops executing.'
	},
	{
		n: 3,
		title: 'History is preserved',
		body: 'The Temporal server still holds every recorded event. Nothing is lost.'
	},
	{
		n: 4,
		title: 'Worker restarts',
		body: 'It replays history and resumes at the exact point it left off.'
	}
];

/** The three surfaces shown side by side in the workbench. */
export const surfaces: Surface[] = [
	{
		title: 'Monaco editor',
		body: 'Edit the workflow and activities live. Saving re-syncs the file and hot-restarts the worker while in-flight workflows survive.',
		icon: [path('m18 16 4-4-4-4'), path('m6 8-4 4 4 4'), path('m14.5 4-5 16')]
	},
	{
		title: 'Temporal Web UI',
		body: 'The real Temporal Web UI, reverse-proxied same-origin into an iframe — inspect executions, history, and search.',
		icon: [rect(3, 3, 7, 9, 1), rect(14, 3, 7, 5, 1), rect(14, 12, 7, 9, 1), rect(3, 16, 7, 5, 1)]
	},
	{
		title: 'Control plane',
		body: 'Start workflows, send signals, run queries and updates — plus a kill-worker chaos button to prove durable recovery.',
		icon: [
			path('M21 4H14'),
			path('M10 4H3'),
			path('M21 12H12'),
			path('M8 12H3'),
			path('M21 20H16'),
			path('M12 20H3'),
			path('M14 2v4'),
			path('M8 10v4'),
			path('M16 18v4')
		]
	}
];

/** Every core Temporal concept the demo workflow exercises. */
export const concepts: Concept[] = [
	{
		title: 'Activities & retries',
		body: 'Charge, notify, and dispatch run as activities with retry policies — transient failures back off automatically.',
		icon: [
			path(
				'M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z'
			)
		]
	},
	{
		title: 'Saga / compensation',
		body: 'If the order fails after charging, a compensation stack issues a refund — every forward step has a symmetric rollback.',
		icon: [
			path(
				'M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z'
			),
			path('m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65'),
			path('m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65')
		]
	},
	{
		title: 'Signals',
		body: 'Restaurant acceptance, food-ready, tips, and cancellation all arrive as signals. The workflow blocks on condition() until they land.',
		icon: [
			path('M10.268 21a2 2 0 0 0 3.464 0'),
			path('M22 8c0-2.3-.8-4.3-2-6'),
			path(
				'M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326'
			),
			path('M4 2C2.8 3.7 2 5.7 2 8')
		]
	},
	{
		title: 'Queries',
		body: 'getStatus returns a live snapshot of workflow state without advancing execution — read-only inspection at any time.',
		icon: [circle(11, 11, 8), path('m21 21-4.3-4.3')]
	},
	{
		title: 'Updates with validators',
		body: 'Change the delivery address only if a synchronous validator accepts it — bad changes are rejected before state mutates.',
		icon: [
			path('M12 20h9'),
			path(
				'M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z'
			)
		]
	},
	{
		title: 'Durable timers',
		body: 'A deadline timer fires if the restaurant doesn’t accept in time. The timer lives in the server and survives worker restarts.',
		icon: [
			path('M10 2h4'),
			path('M12 14v-4'),
			path('M4 13a8 8 0 0 1 8-7 8 8 0 1 1-5.3 14L4 17.6'),
			path('M9 17H4v5')
		]
	},
	{
		title: 'Child workflows',
		body: 'Once a courier is assigned, delivery is handed to a child DeliveryWorkflow, independently visible in the Temporal UI.',
		icon: [
			circle(12, 18, 3),
			circle(6, 6, 3),
			circle(18, 6, 3),
			path('M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9'),
			path('M12 12v3')
		]
	},
	{
		title: 'Search attributes',
		body: 'Order status, customer tier, and restaurant are upserted as real Search Attributes and listed through Temporal Visibility.',
		icon: [
			path('M10 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-5'),
			path('M21 3v5h-5'),
			path('M18 12v4'),
			path('M18 8v.01')
		]
	},
	{
		title: 'Durable recovery',
		body: 'The kill-worker button ends the process mid-flight. Because the server preserves state, the workflow resumes exactly where it stopped.',
		icon: [path('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8'), path('M3 3v5h5')]
	}
];

/** The guided-tour path, from first order to durable recovery. */
export const tour: TourStep[] = [
	{
		n: 1,
		title: 'Place a food order',
		control: 'start-order',
		body: 'Start one durable order workflow. Temporal records the start, then a worker begins running your code.'
	},
	{
		n: 2,
		title: 'Activities run — with automatic retries',
		body: 'Payment, notification, and dispatch run as activities. Transient failures retry with exponential backoff — no retry loops to write.'
	},
	{
		n: 3,
		title: 'A durable timer guards the deadline',
		body: 'The workflow starts an acceptance-deadline timer that lives in the server and fires even if the worker crashes.'
	},
	{
		n: 4,
		title: 'Send a signal to resume',
		control: 'accept-restaurant',
		body: 'The order parks waiting for the restaurant. The accepted signal appends an event and resumes the workflow.'
	},
	{
		n: 5,
		title: 'Update with a synchronous validator',
		control: 'update-address',
		body: 'Change the address while preparing. A validator accepts or rejects before any state mutates.'
	},
	{
		n: 6,
		title: 'Hand delivery to a child workflow',
		control: 'food-ready',
		body: 'Food-ready spawns a DeliveryWorkflow child while the parent keeps owning the order.'
	},
	{
		n: 7,
		title: 'Read state with a query',
		control: 'query-status',
		body: 'Ask the running workflow for its snapshot. Queries inspect state without moving the workflow forward.'
	},
	{
		n: 8,
		title: 'Search across workflows',
		control: 'list-visibility',
		body: 'List executions by indexed Search Attributes — status, tier, restaurant — across every workflow.'
	},
	{
		n: 9,
		title: 'Kill the worker — watch it recover',
		control: 'kill-worker',
		body: 'Kill the process running your code. On restart it replays history and resumes exactly where it left off.'
	},
	{
		n: 10,
		title: 'Finish the delivery',
		control: 'complete-delivery',
		body: 'Complete the child delivery workflow. The parent observes the result and moves the order to delivered.'
	}
];

/** Landing-page FAQ. */
export const faqs: Faq[] = [
	{
		q: 'What is Temporal?',
		a: 'A durable execution platform. You write ordinary code; Temporal records every step so workflows survive process crashes, restarts, and long waits — resuming exactly where they left off.'
	},
	{
		q: 'Do I need to install anything?',
		a: 'No. Everything runs in an ephemeral E2B Firecracker MicroVM that boots inside your session — the Temporal dev server, the CLI, and a TypeScript worker.'
	},
	{
		q: 'How long does a session last?',
		a: 'Sessions are ephemeral and self-destruct after roughly five minutes. It’s a playground, not persistent storage — boot a fresh one whenever you like.'
	},
	{
		q: 'Why a food-ordering workflow?',
		a: 'It’s deliberately over-engineered so a single, familiar scenario can exercise every core Temporal primitive — retries, sagas, signals, queries, updates, timers, child workflows, and recovery.'
	},
	{
		q: 'What is the demo token for?',
		a: 'Sandman uses one shared invite code to gate who can boot sandboxes. Only a hash is ever stored; your submitted token is compared server-side and never exposed.'
	},
	{
		q: 'Can I edit the workflow code?',
		a: 'Yes. Edit the workflow, definitions, and activities in the Monaco editor. Saving hot-restarts the worker while the Temporal server keeps in-flight workflows alive — that’s the durability demo.'
	}
];
