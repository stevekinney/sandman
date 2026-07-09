import { getProductionConfiguration } from '$lib/server/configuration';

export function load(): { inviteCodeRequired: boolean } {
	return {
		inviteCodeRequired: getProductionConfiguration().inviteCodeRequired
	};
}
