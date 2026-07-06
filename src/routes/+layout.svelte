<script lang="ts">
	// Load Cinder's base tokens plus every component stylesheet once at the app root.
	import '@lostgradient/cinder/styles/all';
	import { page } from '$app/state';
	import { OG_IMAGE, SITE_NAME } from '$lib/metadata';

	let { children } = $props();

	// Absolute URLs for scrapers; pages own their titles and descriptions.
	const canonicalUrl = $derived(`${page.url.origin}${page.url.pathname}`);
	const ogImageUrl = $derived(`${page.url.origin}${OG_IMAGE.path}`);
</script>

<svelte:head>
	<link rel="icon" href="https://fav.farm/⏳" />
	<link rel="canonical" href={canonicalUrl} />
	<meta name="theme-color" content="#0b0f17" />
	<meta property="og:site_name" content={SITE_NAME} />
	<meta property="og:type" content="website" />
	<meta property="og:locale" content="en_US" />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:image" content={ogImageUrl} />
	<meta property="og:image:width" content={String(OG_IMAGE.width)} />
	<meta property="og:image:height" content={String(OG_IMAGE.height)} />
	<meta property="og:image:alt" content={OG_IMAGE.alt} />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:image" content={ogImageUrl} />
	<meta name="twitter:image:alt" content={OG_IMAGE.alt} />
</svelte:head>

{@render children()}
