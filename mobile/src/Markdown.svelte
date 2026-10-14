<script lang="ts">
	import { processTokens } from "../../src/lib/utils/marked";
	import { escapeHTML } from "../../src/lib/utils/markedLight";
	import DOMPurify from "dompurify";
	import "katex/dist/katex.min.css";
	let { content }: { content: string } = $props();
	let html = $state("");
	$effect(() => {
		let cancelled = false;
		const input = content;
		processTokens(input, []).then(async (tokens) => {
			const parts = await Promise.all(
				tokens.map((t) =>
					t.type === "text" ? t.html : `<pre><code>${escapeHTML(t.rawCode)}</code></pre>`
				)
			);
			if (!cancelled)
				html = DOMPurify.sanitize(parts.join(""), {
					FORBID_TAGS: ["img", "video", "audio", "iframe"],
					ADD_ATTR: ["target"],
				});
		});
		return () => {
			cancelled = true;
		};
	});
</script>

<div class="markdown">{@html html}</div>
