/**
 * demo-script.spec.ts — anti-drift + data integrity tests for demo-script.ts.
 *
 * Runs in the "server" vitest project (node environment).
 * TypeScript enforces the key-set coverage at compile time; these tests
 * verify the VALUES are consistent at runtime (so CI catches both kinds of drift).
 */

import { describe, expect, it } from 'vitest';
import { FEATURES, ORDER_STATUS } from '$lib/contracts/workflow-api';
import {
	FEATURE_MAP,
	SIGNAL_FEATURE,
	QUERY_FEATURE,
	UPDATE_FEATURE,
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
// 4. Update → feature association coverage
// ---------------------------------------------------------------------------

describe('UPDATE_FEATURE', () => {
	it('every mapped FeatureId exists in FEATURE_MAP', () => {
		for (const [update, featureId] of Object.entries(UPDATE_FEATURE)) {
			expect(
				featureId in FEATURE_MAP,
				`UPDATE_FEATURE["${update}"] points to unknown FeatureId "${featureId}"`
			).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// 5. Control → feature association coverage
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
// 6. SCENARIO_COPY — one entry per OrderStatus
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
// 7. TOUR integrity
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

	it('final step completes only on WorkerRestarted, not WorkerKilled', () => {
		const finalStep = TOUR[TOUR.length - 1];
		const killed = finalStep.completes({
			sequence: 99,
			type: 'WorkerKilled',
			timestamp: new Date().toISOString()
		});
		const restarted = finalStep.completes({
			sequence: 100,
			type: 'WorkerRestarted',
			timestamp: new Date().toISOString()
		});
		expect(killed).toBe(false);
		expect(restarted).toBe(true);
	});
});
