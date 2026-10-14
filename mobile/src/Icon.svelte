<script lang="ts">
	let { name, size = 22 }: { name: string; size?: number } = $props();
	const paths: Record<string, string> = {
		menu: "M4 6h16M4 12h11M4 18h16",
		plus: "M12 5v14M5 12h14",
		chevron: "m6 9 6 6 6-6",
		close: "m6 6 12 12M6 18 18 6",
		send: "M12 19V5m-6 6 6-6 6 6",
		search: "M21 21l-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15",
		check: "m5 12 4 4L19 6",
		copy: "M8 8h12v12H8zM16 8V4H4v12h4",
		chat: "M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l1.5-4A8.5 8.5 0 1 1 21 11.5",
		trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
		settings:
			"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2",
		key: "M14 10a5 5 0 1 0-3 4l7 7h3v-3l-3-3h-3z",
		more: "M5 12h.01M12 12h.01M19 12h.01",
		stop: "M7 7h10v10H7z",
		spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
		arrow: "M7 17 17 7M7 7h10v10",
		download: "M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4",
		back: "m14 6-6 6 6 6",
		edit: "M4 20h4L19 9l-4-4L4 16v4M13.5 6.5l4 4",
		next: "M5 12h14m-6-6 6 6-6 6",
		scene: "M4 5h16v14H4zM4 16l5-5 4 4 2.5-2.5L20 17",
		upload: "M12 16V4m-5 5 5-5 5 5M5 20h14",
	};
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={name === "more" ? 3 : 1.7}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"><path d={paths[name] || paths.chat} /></svg
>
