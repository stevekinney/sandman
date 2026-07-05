/**
 * GET /api/sandbox/[id]/workflow/visibility?status=&customerTier=&restaurantId=
 *
 * Lists workflows through Temporal Visibility using real Search Attributes.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { CUSTOMER_TIER, ORDER_STATUS } from '$lib/contracts/workflow-api';
import type {
	BusinessSnapshot,
	CustomerTier,
	OrderStatus,
	VisibilityWorkflowSummary
} from '$lib/contracts/workflow-api';
import { requireOwnedSandbox } from '$lib/server/security/guards';
import {
	getTemporalCliTarget,
	getTemporalCommandFailureMessage,
	quoteShellArgument,
	runTemporalCommand
} from '$lib/server/sandbox/temporal-cli';

export const GET: RequestHandler = async (event) => {
	const { url, params } = event;
	await requireOwnedSandbox(event, params.id);

	const status = url.searchParams.get('status');
	const customerTier = url.searchParams.get('customerTier');
	const restaurantId = url.searchParams.get('restaurantId');

	if (status !== null && !isOrderStatus(status)) {
		return json({ error: `Unknown order status: ${status}` }, { status: 400 });
	}
	if (customerTier !== null && !isCustomerTier(customerTier)) {
		return json({ error: `Unknown customer tier: ${customerTier}` }, { status: 400 });
	}
	const query = buildVisibilityQuery({ status, customerTier, restaurantId });
	const entry = getTemporalCliTarget(params.id);
	const result = await runTemporalCommand(
		entry,
		[
			'temporal workflow list',
			query.length > 0 ? `--query ${quoteShellArgument(query)}` : '',
			'--color never',
			'-o json'
		]
			.filter(Boolean)
			.join(' ')
	);

	if (result.exitCode !== 0) {
		const message = getTemporalCommandFailureMessage(result, 'Temporal Visibility query failed');
		if (message.toLowerCase().includes('search attribute')) {
			return json(
				{
					error:
						'Search Attributes must be registered before this Visibility lesson can run. Register OrderStatus, CustomerTier, and RestaurantId as Keyword attributes, then retry.'
				},
				{ status: 422 }
			);
		}
		return json({ error: message }, { status: 502 });
	}

	try {
		const parsed: unknown = JSON.parse(result.stdout);
		return json({ workflows: getWorkflowSummaries(parsed) });
	} catch {
		return json({ error: 'Temporal Visibility returned invalid JSON' }, { status: 502 });
	}
};

function buildVisibilityQuery(filter: {
	status: string | null;
	customerTier: string | null;
	restaurantId: string | null;
}): string {
	const clauses = [];
	// `status` and `customerTier` are enum-validated by the caller, so they're
	// known-safe literals. `restaurantId` is free-form and interpolated into a
	// single-quoted Temporal List Filter clause, so escape it: doubling embedded
	// single quotes is the SQL-style escape the filter grammar uses, which keeps
	// a quote-containing value from breaking out of the clause (List Filter
	// injection) while still letting any restaurantId the order path accepted be
	// searched. (The whole query is separately shell-escaped downstream.)
	if (filter.status !== null) clauses.push(`OrderStatus='${filter.status}'`);
	if (filter.customerTier !== null) clauses.push(`CustomerTier='${filter.customerTier}'`);
	if (filter.restaurantId !== null) {
		clauses.push(`RestaurantId='${escapeListFilterLiteral(filter.restaurantId)}'`);
	}
	return clauses.join(' AND ');
}

/** Escape a value for a single-quoted Temporal List Filter literal (`'` → `''`). */
function escapeListFilterLiteral(value: string): string {
	return value.replaceAll("'", "''");
}

function getWorkflowSummaries(value: unknown): VisibilityWorkflowSummary[] {
	const executions = getExecutions(value);
	return executions.map((execution) => ({
		workflowId: getNestedString(execution, ['execution', 'workflowId']) ?? '',
		runId: getNestedString(execution, ['execution', 'runId']) ?? '',
		status: normalizeStatus(getStringProperty(execution, 'status') ?? ''),
		type: getNestedString(execution, ['type', 'name']),
		businessSnapshot: getBusinessSnapshot(execution)
	}));
}

function getExecutions(value: unknown): unknown[] {
	if (!isRecord(value)) return [];
	const executions = value.executions;
	return Array.isArray(executions) ? executions : [];
}

function getBusinessSnapshot(value: unknown): Partial<BusinessSnapshot> {
	const orderStatus = getSearchAttributeValue(value, 'OrderStatus');
	const customerTier = getSearchAttributeValue(value, 'CustomerTier');
	return {
		OrderStatus: orderStatus !== undefined && isOrderStatus(orderStatus) ? orderStatus : undefined,
		CustomerTier:
			customerTier !== undefined && isCustomerTier(customerTier) ? customerTier : undefined,
		RestaurantId: getSearchAttributeValue(value, 'RestaurantId')
	};
}

function getSearchAttributeValue(value: unknown, key: keyof BusinessSnapshot): string | undefined {
	const payload = getNestedUnknown(value, ['searchAttributes', 'indexedFields', key]);
	if (!isRecord(payload)) return undefined;
	const data = getStringProperty(payload, 'data');
	if (data === undefined) return undefined;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
		if (Array.isArray(decoded) && typeof decoded[0] === 'string') return decoded[0];
		if (typeof decoded === 'string') return decoded;
	} catch {
		return undefined;
	}
	return undefined;
}

function normalizeStatus(value: string): string {
	return value.replace(/^WORKFLOW_EXECUTION_STATUS_/, '');
}

function getNestedString(value: unknown, path: string[]): string | undefined {
	const nested = getNestedUnknown(value, path);
	return typeof nested === 'string' ? nested : undefined;
}

function getNestedUnknown(value: unknown, path: string[]): unknown {
	let current = value;
	for (const part of path) {
		if (!isRecord(current)) return undefined;
		current = current[part];
	}
	return current;
}

function getStringProperty(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value[key];
	return typeof candidate === 'string' ? candidate : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isOrderStatus(value: string): value is OrderStatus {
	switch (value) {
		case ORDER_STATUS.Created:
		case ORDER_STATUS.Validating:
		case ORDER_STATUS.AwaitingRestaurant:
		case ORDER_STATUS.Preparing:
		case ORDER_STATUS.AwaitingCourier:
		case ORDER_STATUS.InDelivery:
		case ORDER_STATUS.Delivered:
		case ORDER_STATUS.Cancelled:
		case ORDER_STATUS.Refunded:
			return true;
		default:
			return false;
	}
}

function isCustomerTier(value: string): value is CustomerTier {
	switch (value) {
		case CUSTOMER_TIER.Standard:
		case CUSTOMER_TIER.Premium:
		case CUSTOMER_TIER.Enterprise:
			return true;
		default:
			return false;
	}
}
