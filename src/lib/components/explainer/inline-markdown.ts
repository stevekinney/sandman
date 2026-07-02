/**
 * inline-markdown.ts — tokenizer for the tiny Markdown subset in tour copy.
 *
 * Tour prompts and callout notes only ever use inline code (`x`), bold
 * (**x**), and italics (*x*). A ~30-line tokenizer covers that exactly, with
 * no parser dependency and a guaranteed plain-text fallback: any text that
 * is not one of those three spans passes through verbatim.
 */

/** One rendered span of teaching copy. */
export type InlineToken = {
	kind: 'text' | 'code' | 'strong' | 'emphasis';
	value: string;
};

const SPAN_PATTERN = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/** Split `text` into text/code/strong/emphasis tokens, in order. */
export function tokenizeInlineMarkdown(text: string): InlineToken[] {
	const tokens: InlineToken[] = [];
	let lastIndex = 0;

	SPAN_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(SPAN_PATTERN)) {
		const index = match.index;
		if (index > lastIndex) {
			tokens.push({ kind: 'text', value: text.slice(lastIndex, index) });
		}
		const [, code, strong, emphasis] = match;
		if (code !== undefined) tokens.push({ kind: 'code', value: code });
		else if (strong !== undefined) tokens.push({ kind: 'strong', value: strong });
		else if (emphasis !== undefined) tokens.push({ kind: 'emphasis', value: emphasis });
		lastIndex = index + match[0].length;
	}

	if (lastIndex < text.length) {
		tokens.push({ kind: 'text', value: text.slice(lastIndex) });
	}
	return tokens;
}
