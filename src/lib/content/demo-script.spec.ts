/**
 * demo-script.spec.ts — anti-drift + data integrity tests for demo-script.ts.
 *
 * Runs in the "server" vitest project (node environment).
 * TypeScript enforces the key-set coverage at compile time; these tests
 * verify the VALUES are consistent at runtime (so CI catches both kinds of drift).
 */

import { describe, expect, it } from 'vitest';
import { FEATURES, ORDER_STATUS } from '$lib/contracts/workflow-api';
import workflowSource from '../../../sandbox-template/workflow.ts?raw';
import activitiesSource from '../../../sandbox-template/activities.ts?raw';
import {
	FEATURE_MAP,
	SIGNAL_FEATURE,
	QUERY_FEATURE,
	CONTROL_FEATURE,
	SCENARIO_COPY,
	TOUR
} from './demo-script';

// ---------------------------------------------------------------------------
// 1. FEATURE_MAP integrity
// ---------------------------------------------------------------------------

describe('FEATURE_MAP', () => {
	it('has exactly one entry per FeatureId in the contract FEATURES list', () => {
		const contractIds = FEATURES.map((f) => f.id).sort();
		const mapIds = Object.keys(FEATURE_MAP).sort();
		expect(mapIds).toEqual(contractIds);
	});

	it('every entry has a non-empty concept, oneLiner, and mechanic', () => {
		for (const entry of Object.values(FEATURE_MAP)) {
			expect(entry.concept.length, `concept missing for ${entry.id}`).toBeGreaterThan(0);
			expect(entry.oneLiner.length, `oneLiner missing for ${entry.id}`).toBeGreaterThan(0);
			expect(entry.mechanic.length, `mechanic missing for ${entry.id}`).toBeGreaterThan(0);
		}
	});

	it('every control reference in FEATURE_MAP is a valid ControlId (exists in CONTROL_FEATURE)', () => {
		const validControls = new Set(Object.keys(CONTROL_FEATURE));
		for (const entry of Object.values(FEATURE_MAP)) {
			if (entry.control !== undefined) {
				expect(
					validControls.has(entry.control),
					`control "${entry.control}" in feature "${entry.id}" is not a valid ControlId`
				).toBe(true);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Signal → feature association coverage
// ---------------------------------------------------------------------------

describe('SIGNAL_FEATURE', () => {
	it('every mapped FeatureId exists in FEATURE_MAP', () => {
		for (const [signal, featureId] of Object.entries(SIGNAL_FEATURE)) {
			expect(
				featureId in FEATURE_MAP,
				`SIGNAL_FEATURE["${signal}"] points to unknown FeatureId "${featureId}"`
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Query → feature association coverage
// ---------------------------------------------------------------------------

describe('QUERY_FEATURE', () => {
	it('every mapped FeatureId exists in FEATURE_MAP', () => {
		for (const [query, featureId] of Object.entries(QUERY_FEATURE)) {
			expect(
				featureId in FEATURE_MAP,
				`QUERY_FEATURE["${query}"] points to unknown FeatureId "${featureId}"`
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 4. Control → feature association coverage
// ---------------------------------------------------------------------------

describe('CONTROL_FEATURE', () => {
	it('every mapped FeatureId exists in FEATURE_MAP', () => {
		for (const [control, featureId] of Object.entries(CONTROL_FEATURE)) {
			expect(
				featureId in FEATURE_MAP,
				`CONTROL_FEATURE["${control}"] points to unknown FeatureId "${featureId}"`
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. SCENARIO_COPY — one entry per OrderStatus
// ---------------------------------------------------------------------------

describe('SCENARIO_COPY', () => {
	it('has an entry for every ORDER_STATUS value', () => {
		for (const status of Object.values(ORDER_STATUS)) {
			expect(status in SCENARIO_COPY, `SCENARIO_COPY missing entry for status "${status}"`).toBe(
				true
			);
		}
	});

	it('every entry is a non-empty string', () => {
		for (const [status, copy] of Object.entries(SCENARIO_COPY)) {
			expect(copy.length, `copy for "${status}" is empty`).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// 6. TOUR integrity
// ---------------------------------------------------------------------------

describe('TOUR', () => {
	it('is a non-empty ordered array', () => {
		expect(TOUR.length).toBeGreaterThan(0);
	});

	it('every step has a non-empty id, title, and instruction', () => {
		for (const step of TOUR) {
			expect(step.id.length, `id missing`).toBeGreaterThan(0);
			expect(step.title.length, `title missing for step "${step.id}"`).toBeGreaterThan(0);
			expect(step.instruction.length, `instruction missing for step "${step.id}"`).toBeGreaterThan(
				0
			);
		}
	});

	it('every step has a completes function', () => {
		for (const step of TOUR) {
			expect(typeof step.completes, `completes is not a function for step "${step.id}"`).toBe(
				'function'
			);
		}
	});

	it('every step control (when present) is a valid ControlId', () => {
		const validControls = new Set(Object.keys(CONTROL_FEATURE));
		for (const step of TOUR) {
			if (step.control !== undefined) {
				expect(
					validControls.has(step.control),
					`step "${step.id}" references invalid control "${step.control}"`
				).toBe(true);
			}
		}
	});

	it('all step ids are unique', () => {
		const ids = TOUR.map((s) => s.id);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it('every step has a concept eyebrow and a watch line', () => {
		for (const step of TOUR) {
			expect(step.concept.length, `concept missing for step "${step.id}"`).toBeGreaterThan(0);
			expect(step.watch.length, `watch missing for step "${step.id}"`).toBeGreaterThan(0);
		}
	});

	it('every experiment anchor exists verbatim in its named sandbox file (anti-drift)', () => {
		const sources: Record<string, string> = {
			'workflow.ts': workflowSource,
			'activities.ts': activitiesSource
		};
		for (const step of TOUR) {
			if (step.experiment === undefined) continue;
			const source = sources[step.experiment.file];
			expect(source, `step "${step.id}" experiment names unknown file`).toBeDefined();
			expect(
				source.includes(step.experiment.anchor),
				`step "${step.id}" experiment anchor (${step.experiment.anchor}) must exist in sandbox-template/${step.experiment.file}`
			).toBe(true);
			expect(step.experiment.prompt.length).toBeGreaterThan(0);
		}
	});

	it('every lookAt callout names a real surface and has a note', () => {
		const surfaces = new Set(['temporal-ui', 'events', 'steps']);
		for (const step of TOUR) {
			if (step.lookAt === undefined) continue;
			expect(
				surfaces.has(step.lookAt.surface),
				`step "${step.id}" lookAt surface "${step.lookAt.surface}" is unknown`
			).toBe(true);
			expect(step.lookAt.note.length, `step "${step.id}" lookAt note`).toBeGreaterThan(0);
		}
	});

	it('durable-recovery step completes only on WorkerRestarted, not WorkerKilled', () => {
		const durableRecoveryStep = TOUR.find((step) => step.id === 'durable-recovery');
		expect(durableRecoveryStep).toBeDefined();
		if (durableRecoveryStep === undefined) return;

		const killed = durableRecoveryStep.completes({
			sequence: 99,
			type: 'WorkerKilled',
			timestamp: new Date().toISOString()
		});
		const restarted = durableRecoveryStep.completes({
			sequence: 100,
			type: 'WorkerRestarted',
			timestamp: new Date().toISOString()
		});
		expect(killed).toBe(false);
		expect(restarted).toBe(true);
	});
});
