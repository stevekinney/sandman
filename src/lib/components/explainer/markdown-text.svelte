<script lang="ts">
	/**
	 * markdown-text.svelte — renders the tiny inline-Markdown subset used by
	 * tour copy (inline code, bold, italics). Tokenization lives in
	 * inline-markdown.ts; anything outside the subset renders verbatim, so
	 * copy can never disappear.
	 */
	import { tokenizeInlineMarkdown } from './inline-markdown.ts';

	let { text }: { text: string } = $props();

	const tokens = $derived(tokenizeInlineMarkdown(text));
</script>

<p class="markdown-text__paragraph">
	{#each tokens as token, index (index)}
		{#if token.kind === 'code'}<code class="markdown-text__code">{token.value}</code
			>{:else if token.kind === 'strong'}<strong>{token.value}</strong
			>{:else if token.kind === 'emphasis'}<em>{token.value}</em>{:else}{token.value}{/if}
	{/each}
</p>

<style>
	.markdown-text__paragraph {
		margin: 0;
	}

	.markdown-text__code {
		font-family: var(--cinder-font-mono, monospace);
		font-size: 0.92em;
		padding: 0.08em 0.3em;
		border-radius: 0.25em;
		background: var(--cinder-surface-inset);
		border: 1px solid var(--cinder-border-muted);
		color: var(--cinder-text);
	}
</style>
