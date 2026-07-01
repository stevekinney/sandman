/**
 * inline-markdown.test.ts — unit tests for the tour-copy tokenizer.
 */
import { describe, expect, it } from 'vitest';
import { tokenizeInlineMarkdown } from './inline-markdown.ts';

describe('tokenizeInlineMarkdown', () => {
	it('passes plain text through as a single token', () => {
		expect(tokenizeInlineMarkdown('just words')).toEqual([{ kind: 'text', value: 'just words' }]);
	});

	it('tokenizes inline code, bold, and italics in order', () => {
		expect(tokenizeInlineMarkdown('change `?? 10` to **one** *minute*')).toEqual([
			{ kind: 'text', value: 'change ' },
			{ kind: 'code', value: '?? 10' },
			{ kind: 'text', value: ' to ' },
			{ kind: 'strong', value: 'one' },
			{ kind: 'text', value: ' ' },
			{ kind: 'emphasis', value: 'minute' }
		]);
	});

	it('keeps unbalanced markers as plain text', () => {
		expect(tokenizeInlineMarkdown('a `dangling tick')).toEqual([
			{ kind: 'text', value: 'a `dangling tick' }
		]);
	});

	it('handles code spans containing markdown-ish characters', () => {
		expect(tokenizeInlineMarkdown("`last4 === '0000'`")).toEqual([
			{ kind: 'code', value: "last4 === '0000'" }
		]);
	});

	it('tokenizes every tour prompt and note without losing characters', async () => {
		const { TOUR } = await import('$lib/content/demo-script');
		for (const step of TOUR) {
			for (const copy of [step.experiment?.prompt, step.lookAt?.note]) {
				if (copy === undefined) continue;
				const rendered = tokenizeInlineMarkdown(copy)
					.map((token) =>
						token.kind === 'code'
							? `\`${token.value}\``
							: token.kind === 'strong'
								? `**${token.value}**`
								: token.kind === 'emphasis'
									? `*${token.value}*`
									: token.value
					)
					.join('');
				expect(rendered, `step "${step.id}" copy must round-trip`).toBe(copy);
			}
		}
	});
});
