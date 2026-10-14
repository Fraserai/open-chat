<script lang="ts">
	import { onMount, tick } from "svelte";
	import Icon from "./Icon.svelte";
	import Markdown from "./Markdown.svelte";
	import { readChatStream } from "./chatStream";
	import { backgrounds, type Background } from "./backgrounds";

	type Model = { id: string; name: string; available: boolean; free: boolean };
	type Message = { role: "user" | "assistant"; content: string; failed?: boolean };

	// Background
	let bgId = $state(read("open-chat-bg") || backgrounds[0].id);
	let custom = $state<Background | null>(null);
	let mono = $state(read("open-chat-bg-mono") !== "0");
	let pickerOpen = $state(false);
	let videoReady = $state(false);
	let video: HTMLVideoElement;
	let background = $derived(custom ?? backgrounds.find((b) => b.id === bgId) ?? backgrounds[0]);

	// Chat
	let modelId = $state("");
	let messages = $state<Message[]>([]);
	let chatId = $state<string | null>(null);
	let draft = $state("");
	let loading = $state(false);
	let ready = $state(false);
	let error = $state("");
	let controller: AbortController | undefined;
	let scroller = $state<HTMLDivElement>();
	let input: HTMLTextAreaElement;

	const now = new Date();
	const hour = now.getHours();
	const greeting =
		hour >= 5 && hour < 12 ? "Good morning." : hour >= 12 && hour < 18 ? "Good afternoon." : "Good evening.";
	const today = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

	function read(key: string) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}
	function write(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			/* Preference only lasts this visit. */
		}
	}

	async function api(path: string, method = "GET", data?: unknown) {
		const r = await fetch("/api/" + path, {
			method,
			credentials: "same-origin",
			headers: method === "GET" ? {} : { "Content-Type": "application/json" },
			body: data === undefined ? undefined : JSON.stringify(data),
		});
		const b = await r.json();
		if (!r.ok) throw new Error(b.error || "Could not complete the request.");
		return b;
	}

	onMount(() => {
		(async () => {
			try {
				await api("session", "POST", {});
				const models: Model[] = await api("models");
				const remembered = read("open-chat-model");
				modelId =
					models.find((m) => m.id === remembered)?.id ||
					models.find((m) => m.available && m.free)?.id ||
					models.find((m) => m.available)?.id ||
					models[0]?.id ||
					"";
				ready = true;
			} catch (e) {
				error = (e as Error).message;
			}
		})();
		return () => {
			controller?.abort();
			if (custom) URL.revokeObjectURL(custom.src);
		};
	});

	// Restart playback whenever the clip changes; respect reduced motion.
	$effect(() => {
		background.src;
		videoReady = false;
		if (!video) return;
		video.load();
		if (!matchMedia("(prefers-reduced-motion: reduce)").matches) video.play().catch(() => {});
	});

	function pick(b: Background) {
		if (custom) URL.revokeObjectURL(custom.src);
		custom = null;
		bgId = b.id;
		write("open-chat-bg", b.id);
	}
	function upload(files: FileList | null) {
		const file = files?.[0];
		if (!file) return;
		if (!file.type.startsWith("video/")) {
			error = "Choose a video file (MP4 or WebM).";
			return;
		}
		if (custom) URL.revokeObjectURL(custom.src);
		custom = { id: "custom", name: file.name, src: URL.createObjectURL(file) };
	}
	function toggleMono() {
		mono = !mono;
		write("open-chat-bg-mono", mono ? "1" : "0");
	}

	function grow() {
		input.style.height = "auto";
		input.style.height = Math.min(input.scrollHeight, 180) + "px";
	}
	async function scroll() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	}
	function newChat() {
		if (loading) return;
		messages = [];
		chatId = null;
		error = "";
		input?.focus();
	}
	function keydown(e: KeyboardEvent) {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			send();
		}
	}

	async function send() {
		const text = draft.trim();
		if (!text || loading || !ready) return;
		error = "";
		const before = messages;
		messages = [...messages, { role: "user", content: text }, { role: "assistant", content: "" }];
		draft = "";
		await tick();
		grow();
		loading = true;
		controller = new AbortController();
		scroll();
		let started = false;
		try {
			const r = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, model: modelId, chatId }),
				signal: controller.signal,
			});
			if (!r.ok) {
				const b = await r.json().catch(() => ({}));
				throw new Error(b.error || "Could not send message.");
			}
			await readChatStream(r.body, (event) => {
				if (event.type === "start") {
					started = true;
					chatId = event.chatId;
				}
				if (event.type === "delta") {
					messages[messages.length - 1].content += event.text;
					scroll();
				}
			});
		} catch (e) {
			if (!started) {
				messages = before;
				draft = text;
			} else if (messages.at(-1)) messages[messages.length - 1].failed = true;
			error = (e as Error).name === "AbortError" ? "Response stopped." : (e as Error).message;
		} finally {
			loading = false;
		}
	}
</script>

<div class="scene" class:mono>
	<video
		bind:this={video}
		class="backdrop"
		class:ready={videoReady}
		src={background.src}
		poster={background.poster}
		autoplay
		muted
		loop
		playsinline
		preload="auto"
		aria-hidden="true"
		oncanplay={() => (videoReady = true)}
	></video>
	<div class="shade" aria-hidden="true"></div>

	{#if messages.length}
		<button class="glass round corner-left" onclick={newChat} disabled={loading} aria-label="New chat">
			<Icon name="edit" size={18} />
		</button>
	{/if}
	<button
		class="glass round corner-right"
		onclick={() => (pickerOpen = !pickerOpen)}
		aria-label="Change background"
		aria-expanded={pickerOpen}
	>
		<Icon name="scene" size={18} />
	</button>

	<main class:chatting={messages.length > 0}>
		{#if messages.length === 0}
			<header class="hero">
				<p class="date">{today}</p>
				<h1>{greeting}</h1>
			</header>
		{:else}
			<div class="thread" bind:this={scroller}>
				{#each messages as m, i (i)}
					<div class="msg {m.role}" class:failed={m.failed}>
						{#if m.role === "assistant"}
							{#if m.content}
								<Markdown content={m.content} />
							{:else}
								<span class="typing" aria-label="Thinking"><i></i><i></i><i></i></span>
							{/if}
						{:else}
							{m.content}
						{/if}
					</div>
				{/each}
			</div>
		{/if}

		<form
			class="glass composer"
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				bind:this={input}
				bind:value={draft}
				oninput={grow}
				onkeydown={keydown}
				rows="1"
				placeholder="Ask anything"
				aria-label="Message"
				autofocus
			></textarea>
			{#if loading}
				<button type="button" class="send" onclick={() => controller?.abort()} aria-label="Stop">
					<Icon name="stop" size={18} />
				</button>
			{:else}
				<button type="submit" class="send" disabled={!draft.trim() || !ready} aria-label="Send">
					<Icon name="next" size={20} />
				</button>
			{/if}
		</form>

		{#if error}
			<p class="notice" role="alert">{error}</p>
		{/if}
	</main>

	{#if pickerOpen}
		<div class="glass picker" role="dialog" aria-label="Background">
			<div class="picker-head">
				<span>Background</span>
				<button class="chip" class:on={mono} onclick={toggleMono}>{mono ? "Mono" : "Color"}</button>
			</div>
			<div class="shots">
				{#each backgrounds as b (b.id)}
					<button
						class="shot"
						class:active={!custom && b.id === background.id}
						onclick={() => pick(b)}
						style:background-image={b.poster ? `url(${b.poster})` : undefined}
					>
						<span>{b.name}</span>
					</button>
				{/each}
				<label class="shot upload" class:active={!!custom}>
					<Icon name="upload" size={18} />
					<span>{custom ? custom.name : "Your own"}</span>
					<input type="file" accept="video/mp4,video/webm,video/quicktime" onchange={(e) => upload(e.currentTarget.files)} />
				</label>
			</div>
		</div>
	{/if}
</div>

<style>
	.scene {
		position: fixed;
		inset: 0;
		overflow: hidden;
		color: var(--text);
	}
	.backdrop {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		filter: var(--bg-filter-color);
		transition: opacity 1.2s ease;
	}
	.mono .backdrop {
		filter: var(--bg-filter-mono);
	}
	.backdrop.ready {
		opacity: 1;
	}
	.shade {
		position: absolute;
		inset: 0;
		background:
			radial-gradient(ellipse at center, transparent 30%, rgba(0, 0, 0, 0.35) 100%),
			linear-gradient(to bottom, rgba(0, 0, 0, 0.25), transparent 30%, transparent 70%, rgba(0, 0, 0, 0.35));
		pointer-events: none;
	}

	/* Liquid glass — tweak the tokens in glass.css */
	.glass {
		background:
			linear-gradient(135deg, var(--glass-sheen), transparent 55%),
			var(--glass-tint);
		backdrop-filter: blur(var(--glass-blur)) saturate(160%);
		-webkit-backdrop-filter: blur(var(--glass-blur)) saturate(160%);
		border: 1px solid var(--glass-border);
		box-shadow:
			inset 0 1px 0 var(--glass-highlight),
			inset 0 -1px 1px rgba(255, 255, 255, 0.04),
			0 12px 40px rgba(0, 0, 0, 0.25);
	}

	.round {
		position: absolute;
		z-index: 3;
		top: max(16px, env(safe-area-inset-top));
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		color: var(--text);
		transition: transform 0.2s ease;
	}
	.round:hover {
		transform: scale(1.05);
	}
	.corner-left {
		left: 16px;
	}
	.corner-right {
		right: 16px;
	}

	main {
		position: relative;
		z-index: 2;
		height: 100%;
		width: min(640px, 100% - 32px);
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 20px;
		padding-bottom: 6vh;
	}
	main.chatting {
		justify-content: flex-end;
		padding: max(76px, env(safe-area-inset-top)) 0 max(20px, env(safe-area-inset-bottom));
	}

	.hero {
		text-align: center;
		animation: rise 0.9s ease both;
	}
	.date {
		margin: 0 0 14px;
		font-family: var(--mono);
		font-size: 12px;
		letter-spacing: 0.28em;
		text-transform: uppercase;
		color: var(--text-dim);
	}
	h1 {
		margin: 0 0 12px;
		font-size: clamp(36px, 6vw, 52px);
		font-weight: 500;
		letter-spacing: -0.03em;
		text-shadow: 0 2px 24px rgba(0, 0, 0, 0.3);
	}

	.composer {
		display: flex;
		align-items: flex-end;
		gap: 8px;
		padding: 8px 8px 8px 26px;
		border-radius: 30px;
		animation: rise 0.9s 0.1s ease both;
	}
	.composer:focus-within {
		border-color: var(--glass-border-focus);
	}
	textarea {
		flex: 1;
		resize: none;
		border: 0;
		background: none;
		padding: 13px 0;
		max-height: 180px;
		color: var(--text);
		font-size: 17px;
		line-height: 1.45;
	}
	textarea::placeholder {
		color: var(--text-dim);
	}
	.send {
		flex: none;
		width: 44px;
		height: 44px;
		display: grid;
		place-items: center;
		border-radius: 999px;
		color: var(--text);
		transition: background 0.2s ease;
	}
	.send:not(:disabled):hover {
		background: rgba(255, 255, 255, 0.14);
	}

	.thread {
		flex: 1;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 14px;
		padding: 4px 2px 8px;
		mask-image: linear-gradient(to bottom, transparent, #000 32px);
		scrollbar-width: none;
	}
	.msg {
		max-width: 88%;
		padding: 12px 18px;
		border-radius: 22px;
		line-height: 1.55;
		backdrop-filter: blur(var(--glass-blur)) saturate(160%);
		-webkit-backdrop-filter: blur(var(--glass-blur)) saturate(160%);
		border: 1px solid var(--glass-border);
		animation: rise 0.4s ease both;
	}
	.msg.user {
		align-self: flex-end;
		white-space: pre-wrap;
		background: rgba(255, 255, 255, 0.18);
	}
	.msg.assistant {
		align-self: flex-start;
		background: var(--glass-tint-strong);
	}
	.msg.failed {
		border-color: rgba(255, 140, 140, 0.5);
	}
	.typing {
		display: inline-flex;
		gap: 5px;
		padding: 6px 0;
	}
	.typing i {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: currentColor;
		animation: blink 1.2s infinite ease-in-out;
	}
	.typing i:nth-child(2) {
		animation-delay: 0.15s;
	}
	.typing i:nth-child(3) {
		animation-delay: 0.3s;
	}

	.notice {
		margin: 0;
		text-align: center;
		font-size: 14px;
		color: var(--text-dim);
	}

	.picker {
		position: absolute;
		z-index: 4;
		top: calc(max(16px, env(safe-area-inset-top)) + 56px);
		right: 16px;
		width: min(340px, 100% - 32px);
		padding: 14px;
		border-radius: 24px;
		animation: rise 0.25s ease both;
	}
	.picker-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin: 0 2px 12px;
		font-size: 14px;
		font-weight: 500;
	}
	.chip {
		padding: 5px 12px;
		border-radius: 999px;
		font-size: 12px;
		border: 1px solid var(--glass-border);
	}
	.chip.on {
		background: rgba(255, 255, 255, 0.16);
	}
	.shots {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.shot {
		position: relative;
		aspect-ratio: 16 / 10;
		border-radius: 14px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.08) center / cover;
		border: 1px solid transparent;
		display: flex;
		align-items: flex-end;
		padding: 8px;
		cursor: pointer;
		text-align: left;
	}
	/* Blend instead of `filter`: a filtered child inside a backdrop-filter blanks the video in Chromium. */
	.mono .shot {
		background-color: #808080;
		background-blend-mode: luminosity;
	}
	.shot span {
		font-size: 12px;
		text-shadow: 0 1px 6px rgba(0, 0, 0, 0.7);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.shot.active {
		border-color: rgba(255, 255, 255, 0.85);
	}
	.upload {
		flex-direction: column;
		justify-content: center;
		align-items: center;
		gap: 6px;
		border: 1px dashed var(--glass-border);
	}
	.upload input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
	}
	.upload:focus-within {
		outline: 2px solid rgba(255, 255, 255, 0.7);
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
	}
	@keyframes blink {
		0%,
		80%,
		100% {
			opacity: 0.25;
		}
		40% {
			opacity: 1;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		* {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
