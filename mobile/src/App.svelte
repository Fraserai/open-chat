<script module lang="ts">
	function focusDialog(node: HTMLElement) {
		requestAnimationFrame(() => node.focus());
		return { destroy() {} };
	}
</script>

<script lang="ts">
	import { onMount, tick } from "svelte";
	import Icon from "./Icon.svelte";
	import Markdown from "./Markdown.svelte";
	import { validateAttachments, MAX_FILE_BYTES, isTextFile } from "../shared/attachments.mjs";
	import { readChatStream } from "./chatStream";
	type Model = { id: string; name: string; lab: string; available: boolean; free: boolean };
	type HubModel = {
		id: string;
		author: string;
		downloads: number;
		likes: number;
		license: string;
		url: string;
	};
	type Message = { role: string; content: string; model?: string; failed?: boolean; attachments?: Attachment[] };
	type Attachment = { name: string; type: string; data?: string; text?: string };
	type Chat = { id: string; title: string; model: string; messages: Message[] };
	type User = {
		id: string;
		email: string | null;
		emailVerified: boolean;
		emailReady: boolean;
		plan: string;
		used: number;
		limit: number;
		resetAt: string;
		managedReady: boolean;
		billingReady: boolean;
		productId: string;
		privacyUrl: string;
		termsUrl: string;
		supportEmail: string;
	};

	let models = $state<Model[]>([]),
		chats = $state<Chat[]>([]),
		me = $state<User | null>(null),
		modelId = $state("glm-53");
	let messages = $state<Message[]>([]),
		chatId = $state<string | null>(null),
		draft = $state(""),
		loading = $state(false),
		ready = $state(false),
		error = $state(""),
		toast = $state("");
	let sheet = $state(""),
		modelSource = $state<"curated" | "hub">("curated"),
		sidebar = $state(false),
		search = $state(""),
		hubSearch = $state(""),
		hubModels = $state<HubModel[]>([]),
		hubCursor = $state<string | null>(null),
		hubLoading = $state(false),
		hubError = $state(""),
		chatSearch = $state(""),
		renamingChatId = $state<string | null>(null),
		renameDraft = $state(""),
		email = $state(""),
		password = $state(""),
		authMode = $state("register"),
		authBusy = $state(false);
	let attachments = $state<Attachment[]>([]), toolsOpen = $state(false), filesBusy = $state(false), fileInput: HTMLInputElement;
	let linkPurpose = $state(""), linkToken = $state(""), accountNotice = $state("");
	const attachmentDrafts = new Map<string, Attachment[]>();
	let key = $state(""),
		keyDraft = $state(""),
		native = $state(false),
		nativePrice = $state(""),
		nativeBusy = $state(false),
		controller: AbortController | undefined,
		hubController: AbortController | undefined,
		hubSearchTimer: ReturnType<typeof setTimeout> | undefined,
		scroller: HTMLDivElement;
	let selected = $derived(models.find((m) => m.id === modelId));
	let displayName = $state("");
	let greetingIndex = $state(0);
	let greeting = $derived(
		[
			`What’s on your mind${displayName ? `, ${displayName}` : ""}?`,
			`Where shall we start${displayName ? `, ${displayName}` : ""}?`,
			`What are you curious about${displayName ? `, ${displayName}` : ""}?`,
			`What shall we make${displayName ? `, ${displayName}` : ""}?`,
		][greetingIndex]
	);
	$effect(() => {
		const id = me?.id;
		displayName = "";
		if (id) {
			try {
				displayName = localStorage.getItem(`open-chat-name:${id}`) || "";
			} catch {
				/* Optional local profile. */
			}
		}
	});
	function saveName(value: string) {
		displayName = value.trim().slice(0, 40);
		if (me) {
			try {
				localStorage.setItem(`open-chat-name:${me.id}`, displayName);
			} catch {
				/* Keep it for this session. */
			}
		}
	}
	let visibleModels = $derived(
		models.filter((m) => `${m.name} ${m.lab}`.toLowerCase().includes(search.toLowerCase()))
	);
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
	async function refresh() {
		[me, chats] = await Promise.all([api("me"), api("chats")]);
	}
	async function boot() {
		error = "";
		try {
			me = await api("session", "POST", {});
			[models, chats] = await Promise.all([api("models"), api("chats")]);
			let remembered: string | null = null;
			try {
				remembered = localStorage.getItem("open-chat-model");
			} catch {
				/* Storage may be disabled. */
			}
			if (models.some((m) => m.id === remembered)) modelId = remembered!;
			else if (me?.plan === "free")
				modelId = models.find((m) => m.available && m.free)?.id || modelId;
			if (!chatId && !draft) draft = loadDraft(null);
			ready = true;
			if (native && me?.email)
				window.webkit?.messageHandlers.native.postMessage({ action: "entitlements" });
		} catch (e) {
			error = (e as Error).message;
		}
	}
	onMount(() => {
		const link = new URLSearchParams(window.location.hash.slice(1));
		if (["reset", "verify"].includes(link.get("action") || "") && link.has("token")) {
			linkPurpose = link.get("action")!;
			linkToken = link.get("token")!;
			sheet = "account-link";
			history.replaceState(null, "", window.location.pathname + window.location.search);
		}
		greetingIndex = Math.floor(Math.random() * 4);
		native = !!window.webkit?.messageHandlers.native;
		window.nativeEvent = async (e) => {
			nativeBusy = false;
			if (e.type === "key") key = keyDraft = e.value || "";
			if (e.type === "product") nativePrice = e.price;
			if (e.type === "purchase") {
				try {
					me = await api("apple/verify", "POST", { signedTransaction: e.jws });
					window.webkit?.messageHandlers.native.postMessage({
						action: "finish",
						transactionId: e.transactionId,
					});
					sheet = "";
					notify(
						me?.plan === "plus" ? "Plus is active." : "Purchase checked. No active subscription."
					);
				} catch (err) {
					error = (err as Error).message;
				}
			}
			if (e.type === "error") error = e.message;
			if (e.type === "restored") notify("Purchases restored.");
		};
		boot();
		if (native) window.webkit?.messageHandlers.native.postMessage({ action: "loadKey" });
		return () => {
			clearTimeout(hubSearchTimer);
			hubController?.abort();
			controller?.abort();
			delete window.nativeEvent;
		};
	});
	function notify(s: string) {
		toast = s;
		setTimeout(() => (toast = ""), 3000);
	}
	function choose(m: Model) {
		modelId = m.id;
		try {
			localStorage.setItem("open-chat-model", m.id);
		} catch {
			/* Selection still works in memory. */
		}
		sheet = "";
		search = "";
	}
	function formatCount(value: number) {
		return new Intl.NumberFormat(undefined, {
			notation: "compact",
			maximumFractionDigits: 1,
		}).format(value);
	}
	async function loadHubModels(append = false) {
		hubController?.abort();
		hubController = new AbortController();
		hubLoading = true;
		hubError = "";
		try {
			const params = new URLSearchParams();
			if (hubSearch.trim()) params.set("q", hubSearch.trim());
			if (append && hubCursor) params.set("cursor", hubCursor);
			const response = await fetch(`/api/huggingface-models?${params}`, {
				signal: hubController.signal,
			});
			const data = await response.json();
			if (!response.ok) throw new Error(data.error || "Could not load Hugging Face models.");
			hubModels = append ? [...hubModels, ...data.models] : data.models;
			hubCursor = data.nextCursor;
		} catch (e) {
			if ((e as Error).name !== "AbortError") hubError = (e as Error).message;
		} finally {
			hubLoading = false;
		}
	}
	function openHubModels() {
		modelSource = "hub";
		hubSearch = "";
		hubModels = [];
		hubCursor = null;
		loadHubModels();
	}
	function searchHub(value: string) {
		hubSearch = value;
		clearTimeout(hubSearchTimer);
		hubSearchTimer = setTimeout(() => loadHubModels(), 300);
	}
	function draftStorageKey(id: string | null = chatId) {
		return me ? `open-chat-draft:${me.id}:${id || "new"}` : "";
	}
	function saveDraft() {
		const storageKey = draftStorageKey();
		if (!storageKey) return;
		try {
			if (draft) localStorage.setItem(storageKey, draft);
			else localStorage.removeItem(storageKey);
		} catch {
			/* Draft persistence is optional when browser storage is unavailable. */
		}
	}
	function loadDraft(id: string | null) {
		try {
			return localStorage.getItem(draftStorageKey(id)) || "";
		} catch {
			return "";
		}
	}
	function newChat() {
		if (loading || filesBusy) return;
		attachmentDrafts.set(draftStorageKey(), attachments);
		attachments = attachmentDrafts.get(draftStorageKey(null)) || [];
		saveDraft();
		messages = [];
		chatId = null;
		draft = loadDraft(null);
		error = "";
		sidebar = false;
	}
	function openChat(c: Chat) {
		if (loading || filesBusy) return;
		attachmentDrafts.set(draftStorageKey(), attachments);
		attachments = attachmentDrafts.get(draftStorageKey(c.id)) || [];
		saveDraft();
		messages = c.messages;
		chatId = c.id;
		draft = loadDraft(c.id);
		modelId = c.model;
		sidebar = false;
		error = "";
		scroll();
	}
	async function addFiles(files: FileList | null) {
		if (!files || loading || filesBusy) return;
		filesBusy = true;
		error = "";
		try {
			for (const file of Array.from(files)) {
				if (!isTextFile(file.name, file.type) || file.size > MAX_FILE_BYTES)
					throw new Error("Choose a text file of 64 KB or less (TXT, Markdown, CSV, JSON or XML).");
				attachments = validateAttachments([...attachments, { name: file.name, type: file.type || "text/plain", text: await file.text() }]);
			}
		} catch (e) { error = (e as Error).message; }
		finally { filesBusy = false; if (fileInput) fileInput.value = ""; }
	}
	function startVoice() {
		const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!Speech) { error = "Voice input is not available in this browser."; return; }
		const recognition = new Speech();
		recognition.lang = navigator.language;
		recognition.onresult = (event: any) => { draft = `${draft}${draft ? " " : ""}${event.results[0][0].transcript}`; };
		recognition.onerror = () => (error = "Voice transcription failed.");
		recognition.start();
	}
	async function scroll() {
		await tick();
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	}
	async function send() {
		if (!draft.trim() || loading || filesBusy || !ready) return;
		const text = draft.trim();
		const sentAttachments = attachments;
		error = "";
		const before = messages;
		messages = [
			...messages,
			{ role: "user", content: text, attachments: sentAttachments },
			{ role: "assistant", content: "", model: selected?.name },
		];
		draft = "";
		saveDraft();
		loading = true;
		controller = new AbortController();
		scroll();
		let started = false;
		try {
			const r = await fetch("/api/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(key ? { "X-Provider-Key": key } : {}) },
				body: JSON.stringify({ text, model: modelId, chatId, attachments: sentAttachments }),
				signal: controller.signal,
			});
			if (!r.ok) {
				const b = await r.json();
				throw new Error(b.error || "Could not send message.");
			}
			await readChatStream(r.body, (event) => {
				if (event.type === "start") {
					started = true;
					attachmentDrafts.delete(draftStorageKey());
					attachments = [];
					chatId = event.chatId;
				}
				if (event.type === "delta") {
					messages[messages.length - 1].content += event.text;
					scroll();
				}
			});
			// A history refresh failure does not invalidate a completed model reply.
			await refresh().catch(() => {
				notify("Reply complete. Chat history could not refresh; reconnect to sync it.");
			});
		} catch (e) {
			if (!started) {
				messages = before;
				draft = text;
				saveDraft();
			} else if (messages.at(-1)) messages[messages.length - 1].failed = true;
			error = (e as Error).name === "AbortError" ? "Response stopped." : (e as Error).message;
			if (started) await refresh().catch(() => {});
		} finally {
			loading = false;
		}
	}
	function beginRename(c: Chat) {
		renamingChatId = c.id;
		renameDraft = c.title;
	}
	async function rename(c: Chat) {
		const title = renameDraft.trim();
		if (!title || title === c.title) {
			renamingChatId = null;
			return;
		}
		try {
			await api("chats/" + c.id, "PATCH", { title });
			c.title = title;
			chats = [...chats];
			renamingChatId = null;
			notify("Conversation renamed.");
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function auth() {
		if (loading) {
			error = "Stop the response before changing accounts.";
			return;
		}
		authBusy = true;
		error = "";
		try {
			me = await api("auth", "POST", { email, password, mode: authMode });
			password = "";
			sheet = "";
			await refresh();
			attachmentDrafts.clear();
			attachments = [];
			newChat();
			if (authMode === "register" && me?.emailReady) { sheet = "settings"; notify("Account created. Verify your email in settings."); }
			else notify("Signed in.");
			if (native) window.webkit?.messageHandlers.native.postMessage({ action: "entitlements" });
		} catch (e) {
			error = (e as Error).message;
		} finally {
			authBusy = false;
		}
	}
	async function requestAccountLink(purpose: string) {
		authBusy = true;
		error = "";
		accountNotice = "";
		try {
			const result = await api("account-link", "POST", { purpose, email });
			accountNotice = result.message;
		} catch (e) { error = (e as Error).message; }
		finally { authBusy = false; }
	}
	async function completeAccountLink() {
		if (loading) { error = "Stop the response before changing account details."; return; }
		authBusy = true;
		error = "";
		try {
			await api("account-link/complete", "POST", { purpose: linkPurpose, token: linkToken, password });
			password = "";
			linkToken = "";
			if (linkPurpose === "reset") {
				attachments = []; attachmentDrafts.clear(); messages = []; chatId = null; draft = "";
				key = keyDraft = "";
				window.webkit?.messageHandlers.native.postMessage({ action: "saveKey", value: "" });
				await boot();
				sheet = "account"; authMode = "login";
				accountNotice = "Password updated. Sign in with your new password.";
			} else {
				await refresh(); sheet = "settings";
				accountNotice = "Email verified.";
			}
		} catch (e) { error = (e as Error).message; }
		finally { authBusy = false; }
	}
	async function remove(c: Chat) {
		try {
			await api("chats/" + c.id, "DELETE", {});
			chats = chats.filter((x) => x.id !== c.id);
			if (chatId === c.id) newChat();
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function logout() {
		if (loading) {
			error = "Stop the response before signing out.";
			return;
		}
		try {
			await api("logout", "POST", {});
			attachmentDrafts.clear();
			attachments = [];
			key = "";
			keyDraft = "";
			window.webkit?.messageHandlers.native.postMessage({ action: "saveKey", value: "" });
			newChat();
			sheet = "";
			await boot();
		} catch (e) {
			error = (e as Error).message;
		}
	}
	function saveKey() {
		key = keyDraft.trim();
		if (native)
			window.webkit?.messageHandlers.native.postMessage({ action: "saveKey", value: key });
		sheet = "";
		notify(key ? "Personal key connected." : "Using included access.");
	}
	function plans() {
		sheet = "plans";
		if (native && me)
			window.webkit?.messageHandlers.native.postMessage({
				action: "products",
				productId: me.productId,
			});
	}
	function buy() {
		if (!me?.email) {
			sheet = "account";
			return;
		}
		if (!native || !me.billingReady) return;
		nativeBusy = true;
		window.webkit?.messageHandlers.native.postMessage({
			action: "purchase",
			productId: me.productId,
			accountToken: me.id,
		});
	}
	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			notify("Copied.");
		} catch {
			notify("Could not copy. Select the text to copy it.");
		}
	}
	function exportChats() {
		if (native) {
			window.webkit?.messageHandlers.native.postMessage({
				action: "export",
				value: JSON.stringify(chats, null, 2),
			});
			return;
		}
		const blob = new Blob([JSON.stringify(chats, null, 2)], { type: "application/json" }),
			url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "open-chat-conversations.json";
		a.click();
		URL.revokeObjectURL(url);
	}
	async function deleteAccount() {
		if (loading) {
			error = "Stop the response before deleting your account.";
			return;
		}
		try {
			const deletedUserId = me?.id;
			await api("account", "DELETE", {});
			if (deletedUserId)
				try {
					for (let i = localStorage.length - 1; i >= 0; i--) {
						const itemKey = localStorage.key(i);
						if (itemKey?.startsWith(`open-chat-draft:${deletedUserId}:`))
							localStorage.removeItem(itemKey);
					}
				} catch {
					/* Browser storage may be unavailable. */
				}
			sheet = "";
			messages = [];
			chatId = null;
			attachmentDrafts.clear();
			attachments = [];
			key = "";
			keyDraft = "";
			window.webkit?.messageHandlers.native.postMessage({ action: "saveKey", value: "" });
			await boot();
			notify("Account and chats deleted.");
		} catch (e) {
			error = (e as Error).message;
		}
	}
	function closeSheet() {
		sheet = "";
		error = "";
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === "Escape") {
			closeSheet();
			sidebar = false;
		}
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") {
			e.preventDefault();
			newChat();
		}
	}}
/>
<div class="app-shell" inert={!!sheet}>
	{#if sidebar}<button
			class="sidebar-backdrop"
			aria-label="Close history"
			onclick={() => (sidebar = false)}
		></button>{/if}
	<aside class:open={sidebar}>
		<div class="brand">
			<span class="brand-mark">o<span>c</span></span><strong>Open Chat</strong><button
				class="icon mobile-only"
				aria-label="Close history"
				onclick={() => (sidebar = false)}><Icon name="close" /></button
			>
		</div>
		<button class="new-chat" onclick={newChat} disabled={loading}
			><Icon name="plus" size={19} /> New chat <kbd>⌘ ⇧ O</kbd></button
		>
		<div class="history-search">
			<Icon name="search" size={17} /><input
				aria-label="Search conversations"
				placeholder="Search chats"
				bind:value={chatSearch}
			/>
		</div>
		<p class="section-label">YOUR CONVERSATIONS</p>
		<div class="history">
			{#each chats.filter((c) => c.title.toLowerCase().includes(chatSearch.toLowerCase())) as c}<div
					class:current={chatId === c.id}
					class="history-row"
				>
					{#if renamingChatId === c.id}<form
							class="rename-chat"
							onsubmit={(e) => {
								e.preventDefault();
								rename(c);
							}}
						>
							<input
								aria-label="Conversation name"
								maxlength="80"
								bind:value={renameDraft}
								onkeydown={(e) => {
									if (e.key === "Escape") renamingChatId = null;
								}}
							/>
							<button aria-label="Save conversation name" disabled={!renameDraft.trim()}
								><Icon name="check" size={15} /></button
							>
						</form>{:else}<button onclick={() => openChat(c)} disabled={loading}
							><Icon name="chat" size={17} /><span>{c.title}</span></button
						><button
							class="edit-chat"
							aria-label={"Rename " + c.title}
							disabled={loading}
							onclick={() => beginRename(c)}><Icon name="edit" size={15} /></button
						>{/if}<button
						class="delete-chat"
						aria-label={"Delete " + c.title}
						disabled={loading}
						onclick={() => remove(c)}><Icon name="trash" size={16} /></button
					>
				</div>{:else}<p class="history-empty">Your conversations will appear here.</p>{/each}
		</div>
		<div class="sidebar-footer">
			<button class="upgrade-card" onclick={plans}
				><span class="plus-symbol"><Icon name="spark" size={20} /></span><span
					><strong>{me?.plan === "plus" ? "You’re on Plus" : "More room to explore"}</strong><small
						>{me?.plan === "plus" ? "Manage your subscription" : "Explore Open Chat Plus"}</small
					></span
				><Icon name="chevron" size={16} /></button
			><button class="profile" onclick={() => (sheet = "settings")}
				><span class="avatar">{me?.email?.slice(0, 1).toUpperCase() || "Y"}</span><span
					><strong>{me?.email?.split("@")[0] || "Your space"}</strong><small
						>{key ? "Personal API key" : me?.plan === "plus" ? "Plus plan" : "Free plan"}</small
					></span
				><Icon name="settings" size={19} /></button
			>
		</div>
	</aside>
	<main>
		<header>
			<button class="icon mobile-only" aria-label="Open history" onclick={() => (sidebar = true)}
				><Icon name="menu" /></button
			><button class="model-button" onclick={() => (sheet = "models")} disabled={loading}
				><span>{selected?.name || "Choose model"}</span><Icon name="chevron" size={17} /></button
			>
			<div class="header-right">
				<button class="icon" aria-label="Chat settings" onclick={() => (sheet = "settings")}
					><Icon name="more" /></button
				>
			</div>
		</header>
		<div class="conversation" bind:this={scroller}>
			{#if !messages.length}<section class="welcome">
					<div class="welcome-emblem"><Icon name="spark" size={30} /></div>
					<h1 class="greeting">
						{#key greetingIndex}<span>{greeting}</span>{/key}
					</h1>
				</section>{:else}<div class="messages">
					{#each messages as message, i}<article
							class:user={message.role === "user"}
							class="message"
						>
							{#if message.role === "assistant"}<div class="answer-model">
									<span class="tiny-mark"><Icon name="spark" size={15} /></span>{message.model ||
										selected?.name}
								</div>{/if}
							{#if message.attachments?.length}<div class="attachment-list">{#each message.attachments as file}<details><summary>{file.name}</summary><pre>{file.text}</pre></details>{/each}</div>{/if}
							<div class="message-content">
								{#if message.role === "user"}{message.content}{:else if !message.content && loading}<span
										class="thinking">Thinking<span> · · ·</span></span
									>{:else}<Markdown content={message.content} />{/if}
							</div>
							{#if message.role === "assistant" && message.content && (!loading || i !== messages.length - 1)}<div
									class="answer-actions"
								>
									<button
										class="icon"
										aria-label="Copy response"
										onclick={() => copy(message.content)}><Icon name="copy" size={16} /></button
									>{#if message.failed}<span>Response interrupted</span>{/if}
								</div>{/if}
						</article>{/each}
				</div>{/if}
		</div>
		<div class="composer-region">
			{#if error && !sheet}<div class="error" role="alert">
					<span>{error}</span>{#if !ready}<button type="button" onclick={boot}>Reconnect</button
						>{/if}<button class="icon" aria-label="Dismiss error" onclick={() => (error = "")}
						><Icon name="close" size={17} /></button
					>
				</div>{/if}
			{#if attachments.length}<div class="attachment-list" aria-label="Attached files">
				{#each attachments as file, index}<span>{file.name}<button type="button" disabled={loading} aria-label={"Remove " + file.name} onclick={() => (attachments = attachments.filter((_, i) => i !== index))}>×</button></span>{/each}
			</div>{/if}
			<form
				class="composer"
				onsubmit={(e) => {
					e.preventDefault();
					send();
				}}
			>
				<textarea
					aria-label="Message"
					placeholder={selected
						? "Message " + selected.name.replace(/ \(.*\)/, "")
						: "Ask anything…"}
					bind:value={draft}
					oninput={(e) => {
						draft = e.currentTarget.value;
						saveDraft();
					}}
					rows="1"
					maxlength="16000"
					onkeydown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
							e.preventDefault();
							send();
						}
					}}
				></textarea>
				<div class="composer-tools">
					<div class="composer-features">
						<input bind:this={fileInput} hidden type="file" accept=".txt,.md,.csv,.json,.xml,text/plain,text/markdown,text/csv,application/json,application/xml" disabled={loading || filesBusy} multiple onchange={(e) => addFiles(e.currentTarget.files)} />
						<button type="button" disabled={loading || filesBusy} class="composer-plus" aria-label="Add to message" aria-expanded={toolsOpen} onclick={() => (toolsOpen = !toolsOpen)}><Icon name="plus" size={18} /></button>
						{#if toolsOpen}<div class="composer-feature-menu">
							<button type="button" onclick={() => { toolsOpen = false; fileInput?.click(); }}><Icon name="plus" size={15} />Add file</button>
							<span class="fine-print">Text files up to 64 KB each, 80 KB total. Images and web search are not enabled yet.</span>
							<button type="button" onclick={() => { toolsOpen = false; startVoice(); }}><Icon name="mic" size={15} />Voice input</button>
						</div>{/if}
					</div>
					{#if attachments.length}<span class="attachment-count">{attachments.length} file{attachments.length === 1 ? "" : "s"}</span>{/if}
					<button
						type="button"
						class="composer-model"
						onclick={() => (sheet = "models")}
						disabled={loading}
						><Icon name="spark" size={16} /><span>{selected?.lab || "Open models"}</span><Icon
							name="chevron"
							size={13}
						/></button
					>{#if loading}<button
							type="button"
							class="send-button"
							aria-label="Stop response"
							onclick={() => controller?.abort()}><Icon name="stop" size={18} /></button
						>{:else}<button
							class="send-button"
							type="submit"
							disabled={!draft.trim() || !ready || filesBusy}
							aria-label="Send message"><Icon name="send" size={21} /></button
						>{/if}
				</div>
			</form>
			<div class="composer-footnote">
				<span>AI can make mistakes. Check important details.</span><span class="usage"
					>{key
						? "Your key, your usage"
						: `${me?.used || 0} / ${me?.limit || 10} messages today`}</span
				>
			</div>
		</div>
	</main>
</div>
{#if sheet}
	<div
		class="modal-layer"
		role="presentation"
		onclick={(e) => {
			if (e.target === e.currentTarget) closeSheet();
		}}
	>
		<div
			class="sheet"
			class:model-sheet={sheet === "models"}
			role="dialog"
			aria-modal="true"
			aria-label={sheet === "models"
				? "Choose model"
				: sheet === "plans"
					? "Open Chat Plus"
					: "Account settings"}
			tabindex="-1"
			onkeydown={(e) => {
				if (e.key === "Tab") {
					const els = Array.from(
						e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input,a[href]")
					);
					const first = els[0],
						last = els.at(-1);
					if (e.shiftKey && document.activeElement === first) {
						e.preventDefault();
						last?.focus();
					} else if (!e.shiftKey && document.activeElement === last) {
						e.preventDefault();
						first?.focus();
					}
				}
			}}
			use:focusDialog
		>
			<div class="drag-handle"></div>
			<button class="icon sheet-close" aria-label="Close dialog" onclick={closeSheet}
				><Icon name="close" size={20} /></button
			>
			{#if sheet === "models"}
				{#if modelSource === "curated"}<h2>Choose Model</h2>
					<p class="sheet-subtitle">Best open models, ready when you are.</p>
					<div class="model-search">
						<Icon name="search" size={18} /><input
							aria-label="Search models"
							placeholder="Find your model"
							bind:value={search}
						/>
					</div>
					<div class="model-list">
						{#each visibleModels as m}<button
								class="model-row"
								class:selected={m.id === modelId}
								onclick={() => choose(m)}
								><span
									><strong>{m.name}</strong><small
										>{m.lab}{!m.available
											? " · Not connected"
											: m.free
												? " · Free access"
												: " · Plus"}</small
									></span
								><span class="radio" class:checked={m.id === modelId}></span></button
							>{:else}<p class="empty-result">No models match “{search}”.</p>{/each}
					</div>
					<div class="model-bottom">
						<button class="hub-explore" onclick={openHubModels}
							><Icon name="search" size={15} /> Explore Hugging Face</button
						>
						<button onclick={() => (sheet = "keys")}
							>Use your own key <Icon name="arrow" size={14} /></button
						>
					</div>{:else}<div class="hub-heading">
						<button class="hub-back" onclick={() => (modelSource = "curated")}
							><Icon name="back" size={17} /> Models</button
						>
						<h2>Explore Hugging Face</h2>
						<p class="sheet-subtitle">Public text-generation models with declared open licences.</p>
					</div>
					<div class="model-search">
						<Icon name="search" size={18} /><input
							aria-label="Search Hugging Face models"
							placeholder="Search models or creators"
							value={hubSearch}
							oninput={(e) => searchHub(e.currentTarget.value)}
						/>
					</div>
					<div class="model-list hub-list">
						{#if hubError}<div class="hub-state">
								<p>{hubError}</p>
								<button onclick={() => loadHubModels()}>Try again</button>
							</div>
						{:else if hubLoading && !hubModels.length}<p class="hub-state">
								Looking across the Hub…
							</p>
						{:else if !hubModels.length}<p class="hub-state">No open text models found.</p>
						{:else}{#each hubModels as model}<a
									class="model-row hub-row"
									href={model.url}
									target="_blank"
									rel="noreferrer"
								>
									<span
										><strong>{model.id.split("/").at(-1)}</strong><small
											>{model.author} · {model.license} · {formatCount(model.downloads)} downloads · {formatCount(
												model.likes
											)} likes</small
										></span
									><Icon name="arrow" size={15} />
								</a>{/each}{/if}
					</div>
					<div class="model-bottom hub-footer">
						<span>Catalogue models are for discovery and aren’t connected to chat yet.</span
						>{#if hubCursor}<button disabled={hubLoading} onclick={() => loadHubModels(true)}
								>{hubLoading ? "Loading…" : "Load more"}</button
							>{/if}
					</div>{/if}
			{:else if sheet === "settings"}
				<h2>Your space</h2>
				<p class="sheet-subtitle">{me?.email || "Chat freely. Make it yours."}</p>
				<label class="key-label"
					>What should we call you?
					<input
						autocomplete="given-name"
						maxlength="40"
						placeholder="Your name"
						value={displayName}
						onchange={(e) => saveName(e.currentTarget.value)}
					/>
					<small>Saved for this account in this browser.</small>
				</label>
				<div class="allowance">
					<div>
						<strong>{me?.plan === "plus" ? "Plus" : "Free"} allowance</strong><span
							>{me?.used || 0} / {me?.limit || 10}</span
						>
					</div>
					<progress value={me?.used || 0} max={me?.limit || 10}></progress><small
						>Daily message limit resets at midnight UTC. Inference budgets also apply.</small
					>
				</div>
				{#if me?.email}<p class="fine-print">{me.emailVerified ? "Email verified" : "Email not yet verified"}</p>
					{#if !me.emailVerified}<button class="text-button" disabled={authBusy || !me.emailReady} onclick={() => requestAccountLink("verify")}>Send verification email</button>{/if}
				{/if}
				<div class="settings-list">
					{#if !me?.email}<button onclick={() => (sheet = "account")}
							><Icon name="chat" /><span
								>Create account or sign in<small>Keep your chats across devices</small></span
							><Icon name="chevron" size={16} /></button
						>{/if}<button onclick={plans}
						><Icon name="spark" /><span
							>Open Chat Plus<small
								>{me?.plan === "plus"
									? "Manage your plan"
									: "A larger allowance for your ideas"}</small
							></span
						><Icon name="chevron" size={16} /></button
					><button
						onclick={() => {
							sheet = "keys";
							keyDraft = key;
						}}
						><Icon name="key" /><span
							>Bring your own key<small>{key ? "Connected" : "Optional · OpenRouter"}</small></span
						><Icon name="chevron" size={16} /></button
					><button onclick={exportChats}
						><Icon name="download" /><span>Export conversations</span></button
					><button onclick={() => (sheet = "privacy")}
						><Icon name="settings" /><span>Privacy & about</span></button
					>{#if me?.email}<button onclick={logout}><Icon name="back" /><span>Sign out</span></button
						>{/if}<button class="danger" onclick={() => (sheet = "delete")}
						><Icon name="trash" /><span>Delete {me?.email ? "account" : "guest data"}</span></button
					>
				</div>
			{:else if sheet === "plans"}
				<div class="plan-icon"><Icon name="spark" size={27} /></div>
				<h2>More room for your ideas.</h2>
				<p class="sheet-subtitle">Open Chat Plus</p>
				<div class="plan-price">
					{nativePrice || "Coming soon"}{#if nativePrice}<small> / month</small>{/if}
				</div>
				<ul class="plan-benefits">
					<li><Icon name="check" size={18} /> Access to all connected models</li>
					<li><Icon name="check" size={18} /> A larger daily message allowance</li>
					<li><Icon name="check" size={18} /> Your conversations, in one place</li>
				</ul>
				<p class="fine-print">
					Usage limits apply. Models vary in inference cost; your included budget may be reached
					before your message limit.
				</p>
				<button
					class="primary"
					onclick={buy}
					disabled={nativeBusy ||
						!native ||
						!me?.billingReady ||
						!nativePrice ||
						me?.plan === "plus"}
					>{nativeBusy
						? "Connecting to App Store…"
						: me?.plan === "plus"
							? "Plus is active"
							: !native || !me?.billingReady
								? "Subscriptions aren’t enabled yet"
								: me?.email
									? "Subscribe with Apple"
									: "Create account to subscribe"}</button
				>{#if native}<button
						class="text-button"
						disabled={nativeBusy}
						onclick={() => {
							nativeBusy = true;
							window.webkit?.messageHandlers.native.postMessage({ action: "restore" });
						}}>Restore purchases</button
					><button
						class="text-button"
						onclick={() => window.webkit?.messageHandlers.native.postMessage({ action: "manage" })}
						>Manage Apple subscription</button
					>{/if}{#if me?.privacyUrl && me?.termsUrl}<p class="fine-print">
						Auto-renews monthly unless cancelled in Apple settings. <a
							href={me.termsUrl}
							target="_blank"
							rel="noreferrer">Terms</a
						>
						· <a href={me.privacyUrl} target="_blank" rel="noreferrer">Privacy</a>
					</p>{/if}
			{:else if sheet === "account-link"}
				<h2>{linkPurpose === "reset" ? "Choose a new password." : "Verify your email."}</h2>
				<form class="account-form" onsubmit={(e) => { e.preventDefault(); completeAccountLink(); }}>
					{#if linkPurpose === "reset"}<label>New password<input type="password" autocomplete="new-password" required minlength="12" maxlength="128" bind:value={password} /></label>{/if}
					<button class="primary" disabled={authBusy}>{authBusy ? "Please wait…" : linkPurpose === "reset" ? "Update password" : "Verify email"}</button>
				</form>
			{:else if sheet === "recovery"}
				<h2>Reset your password.</h2>
				<p class="sheet-subtitle">We’ll email you a link that works once and expires in 30 minutes.</p>
				<form class="account-form" onsubmit={(e) => { e.preventDefault(); requestAccountLink("reset"); }}>
					<label>Email<input type="email" autocomplete="email" required bind:value={email} /></label>
					<button class="primary" disabled={authBusy || !me?.emailReady}>{authBusy ? "Please wait…" : "Send reset link"}</button>
				</form>
				{#if !me?.emailReady}<p class="fine-print">Password recovery email is not configured yet.</p>{/if}
				<button class="text-button" onclick={() => { sheet = "account"; authMode = "login"; }}>Back to sign in</button>
			{:else if sheet === "account"}
				<h2>{authMode === "register" ? "Make this your space." : "Welcome back."}</h2>
				<p class="sheet-subtitle">
					{authMode === "register"
						? "Save your chats and unlock subscriptions."
						: "Your conversations are waiting."}
				</p>
				<form
					class="account-form"
					onsubmit={(e) => {
						e.preventDefault();
						auth();
					}}
				>
					<label>Email<input type="email" autocomplete="email" required bind:value={email} /></label
					><label
						>Password<input
							type="password"
							autocomplete={authMode === "register" ? "new-password" : "current-password"}
							minlength="12"
							maxlength="128"
							required
							bind:value={password}
						/><small>At least 12 characters</small></label
					><button class="primary" disabled={authBusy}
						>{authBusy
							? "Please wait…"
							: authMode === "register"
								? "Create account"
								: "Sign in"}</button
					>
				</form>
				<button
					class="text-button"
					onclick={() => {
						authMode = authMode === "register" ? "login" : "register";
						error = "";
					}}
					>{authMode === "register"
						? "Already have an account? Sign in"
						: "New here? Create account"}</button
				>
							{#if authMode === "login"}<button class="text-button" onclick={() => { sheet = "recovery"; accountNotice = ""; error = ""; }}>Forgot password?</button>{/if}
			{:else if sheet === "keys"}
				<h2>Your key. Your choice.</h2>
				<p class="sheet-subtitle">Optional OpenRouter access</p>
				<p class="body-copy">
					Use included access, or connect your own key. With a personal key, OpenRouter bills your
					usage directly.
				</p>
				<label class="key-label"
					>OpenRouter API key<input
						type="password"
						autocomplete="off"
						placeholder="sk-or-…"
						bind:value={keyDraft}
					/></label
				>
				<p class="fine-print">
					{native
						? "Stored securely in your iPhone Keychain."
						: "Kept only in memory for this session."} Your key is sent over the app’s connection to our
					inference gateway and is never saved by the server.
				</p>
				<button class="primary" onclick={saveKey}>Save preference</button>{#if key}<button
						class="text-button"
						onclick={() => {
							keyDraft = "";
							saveKey();
						}}>Disconnect personal key</button
					>{/if}
			{:else if sheet === "privacy"}
				<h2>Privacy & about</h2>
				<div class="body-copy">
					<p>
						Conversations are saved to your account on this service. Your messages are sent to the
						selected inference provider to generate replies.
					</p>
					<p>
						Guest access is tied to this device’s session. Create an account to access your chats
						elsewhere. Personal API keys are never stored on our server.
					</p>
					<p>
						You can export your conversations or delete your account in settings. Deleting an
						account does not cancel an Apple subscription; manage that in your Apple settings.
					</p>
					<p>
						Built using Hugging Face’s open-source Chat UI. This is an independent app, not an
						official Hugging Face product.
					</p>
					{#if me?.privacyUrl}<p>
							<a href={me.privacyUrl} target="_blank" rel="noreferrer">Privacy policy</a>
						</p>{/if}{#if me?.supportEmail}<p>
							<a href={"mailto:" + me.supportEmail}>Contact support</a>
						</p>{/if}
				</div>
			{:else if sheet === "delete"}
				<h2>Delete your data?</h2>
				<p class="body-copy">
					This permanently deletes your account and saved conversations. Export anything you want to
					keep first. Apple subscriptions must be cancelled separately in Apple settings.
				</p>
				<button class="primary destructive" onclick={deleteAccount}>Delete my data</button><button
					class="text-button"
					onclick={() => (sheet = "settings")}>Keep my account</button
				>
			{/if}
			{#if accountNotice}<p role="status" class="fine-print">{accountNotice}</p>{/if}
			{#if error}<div class="error" role="alert">{error}</div>{/if}
		</div>
	</div>
{/if}
{#if toast}<div class="toast" role="status"><Icon name="check" size={17} />{toast}</div>{/if}
