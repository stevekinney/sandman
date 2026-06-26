<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	// Global Cinder styles — loaded here so all routes get the design tokens.
	// Individual component /styles sub-paths are not used because svelte-check
	// cannot resolve them; the root styles import covers all components.
	import '@lostgradient/cinder/styles';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
