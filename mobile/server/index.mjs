import { createServer } from "node:http";
import { isIP } from "node:net";
import {
	randomUUID,
	randomBytes,
	createHash,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import OpenAI from "openai";
import { openAIChatToTextGenerationStream } from "../../src/lib/server/endpoints/openai/openAIChatToTextGenerationStream.ts";
import { openStore, reserve, refund, isPlus, recordTransaction } from "./store.mjs";
import { loadCatalog, enabled } from "./catalog.mjs";
import { validateAttachments, providerMessage, MAX_CONTEXT_BYTES } from "../shared/attachments.mjs";
import { appleVerifier } from "./apple.mjs";
import { initAccountTokens, passwordHash, issueToken, tokenUser, consumeToken, emailVerified } from "./account-tokens.mjs";
import { mailReady, sendAccountLink } from "./mail.mjs";
const scrypt = promisify(scryptCallback),
	db = openStore(process.env.DATABASE_PATH || "./data/open-chat.sqlite");
initAccountTokens(db);
const env = process.env,
	origin = env.APP_ORIGIN || "http://localhost:3001",
	production = env.NODE_ENV === "production";
const port = Number(env.PORT || 3001),
	product = env.APPLE_PRODUCT_ID || "au.openchat.app.plus.monthly";
const base = env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
if (
	!["https://openrouter.ai/api/v1", "https://router.huggingface.co/v1"].includes(base) &&
	!(env.TEST_PROVIDER === "1" && !production && new URL(base).hostname === "127.0.0.1")
)
	throw new Error("Provider base URL must be an approved inference provider.");
const catalog = () => loadCatalog(env.MODEL_MAP_PATH || "./model-map.json");
const n = (k, d) => {
	const v = Number(env[k] || d);
	if (!Number.isFinite(v) || v <= 0) throw new Error("Invalid " + k);
	return v;
};
const freeMessages = n("FREE_DAILY_MESSAGES", 10),
	plusMessages = n("PLUS_DAILY_MESSAGES", 200),
	maxTokens = n("MAX_OUTPUT_TOKENS", 2048);
const hash = (s) => createHash("sha256").update(s).digest("hex");
const active = new Set();
const hubModelCache = new Map();
function nextHubCursor(link) {
	const next = String(link || "")
		.split(",")
		.find((part) => /rel="next"/.test(part));
	const match = next?.match(/<([^>]+)>/);
	if (!match) return null;
	try {
		const url = new URL(match[1]);
		return url.origin === "https://huggingface.co" && url.pathname === "/api/models"
			? url.searchParams.get("cursor")
			: null;
	} catch {
		return null;
	}
}
async function hubModels(query, cursor) {
	const cacheKey = `${query}:${cursor}`;
	const cached = hubModelCache.get(cacheKey);
	if (cached && cached.expires > Date.now()) return cached.value;
	const url = new URL("https://huggingface.co/api/models");
	for (const [key, value] of Object.entries({
		pipeline_tag: "text-generation",
		sort: "trendingScore",
		direction: "-1",
		limit: "80",
		gated: "false",
	}))
		url.searchParams.set(key, value);
	for (const field of ["author", "downloads", "likes", "pipeline_tag", "gated", "tags"])
		url.searchParams.append("expand[]", field);
	if (query) url.searchParams.set("search", query);
	if (cursor) url.searchParams.set("cursor", cursor);
	const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
	if (!response.ok)
		throw Object.assign(new Error("Hugging Face catalogue is unavailable."), { status: 502 });
	const raw = await response.json();
	const models = raw
		.filter(
			(model) => model.gated === false && model.tags?.some((tag) => tag.startsWith("license:"))
		)
		.slice(0, 40)
		.map((model) => ({
			id: model.id,
			author: model.author || model.id.split("/")[0],
			downloads: Number(model.downloads) || 0,
			likes: Number(model.likes) || 0,
			license: model.tags.find((tag) => tag.startsWith("license:"))?.slice(8) || "unknown",
			url: `https://huggingface.co/${model.id}`,
		}));
	const value = { models, nextCursor: nextHubCursor(response.headers.get("link")) };
	if (hubModelCache.size > 100) hubModelCache.clear();
	hubModelCache.set(cacheKey, { value, expires: Date.now() + 300000 });
	return value;
}
function clientIP(req) {
	const remote = req.socket.remoteAddress || "unknown";
	const trusted = (env.TRUSTED_PROXY_IPS || "").split(",");
	if (trusted.includes(remote)) {
		const candidate = String(req.headers["x-forwarded-for"] || "")
			.split(",")
			.at(-1)
			.trim();
		if (isIP(candidate)) return candidate;
	}
	return remote;
}
const fail = (status, message) => {
	throw Object.assign(new Error(message), { status });
};
function json(res, status, data) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(data));
}
async function body(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > 8_000_000) fail(413, "This request is too large.");
		chunks.push(chunk);
	}
	try {
		const text = Buffer.concat(chunks).toString("utf8");
		const data = JSON.parse(text || "{}");
		if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "Invalid request.");
		return data;
	} catch {
		fail(400, "Invalid request.");
	}
}
function throttle(key, limit, window = 60000) {
	const now = Date.now();
	db.prepare("DELETE FROM rate_limits WHERE expires<?").run(now);
	const r = db.prepare("SELECT * FROM rate_limits WHERE key=?").get(key);
	if (r?.count >= limit) fail(429, "Too many attempts. Please try again shortly.");
	db.prepare(
		"INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1"
	).run(key, 1, now + window);
}
function user(req) {
	const token = req.headers.cookie?.match(/(?:^|; )oc_session=([^;]+)/)?.[1];
	if (!token) return null;
	return db
		.prepare(
			"SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND expires>?"
		)
		.get(hash(token), Date.now());
}
function session(res, id) {
	const token = randomBytes(32).toString("hex");
	db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(hash(token), id, Date.now() + 30 * 86400000);
	res.setHeader(
		"Set-Cookie",
		`oc_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${production ? "; Secure" : ""}`
	);
}
function bucket(key) {
	return db.prepare("SELECT used FROM buckets WHERE key=?").get(key)?.used || 0;
}
function status(u) {
	const plus = isPlus(db, u.id),
		day = new Date().toISOString().slice(0, 10);
	return {
		id: u.id,
		email: u.email,
		emailVerified: emailVerified(db, u),
		emailReady: mailReady(env),
		plan: plus ? "plus" : "free",
		used: bucket(`messages:${u.id}:${day}`),
		limit: plus ? plusMessages : freeMessages,
		resetAt: new Date(Date.parse(day) + 86400000).toISOString(),
		managedReady: !!env.OPENAI_API_KEY && catalog().some(enabled),
		billingReady: !!env.APPLE_ROOT_CA_PATHS && !!env.PRIVACY_URL && !!env.TERMS_URL,
		productId: product,
		privacyUrl: env.PRIVACY_URL || "",
		termsUrl: env.TERMS_URL || "",
		supportEmail: env.SUPPORT_EMAIL || "",
	};
}
const server = createServer(async (req, res) => {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
	);
	const ip = hash(clientIP(req));
	try {
		let url;
		try { url = new URL(req.url, origin); } catch { fail(400, "Invalid request URL."); }
		const path = url.pathname;
		if (path === "/api/health")
			{ db.prepare("SELECT 1").get(); return json(res, 200, { ok: true }); }
		if (path.startsWith("/api/")) {
			throttle(`requests:${ip}`, 240);
			if (!["GET", "HEAD"].includes(req.method) && path !== "/api/apple/notifications") {
				if (req.headers.origin !== origin) fail(403, "Request origin is not allowed.");
				if (!req.headers["content-type"]?.startsWith("application/json"))
					fail(415, "JSON is required.");
			}
		}
		if (path === "/api/apple/notifications" && req.method === "POST") {
			const payload = await body(req);
			const notice = await appleVerifier().verifyAndDecodeNotification(payload.signedPayload);
			if (notice.data?.signedTransactionInfo) {
				const tx = await appleVerifier().verifyAndDecodeTransaction(
					notice.data.signedTransactionInfo
				);
				const owner = db
					.prepare("SELECT user_id FROM owners WHERE original_id=?")
					.get(tx.originalTransactionId);
				if (owner) recordTransaction(db, tx, owner.user_id, product);
			}
			return json(res, 200, { ok: true });
		}
		let u = user(req);
		if (path === "/api/session" && req.method === "POST") {
			if (!u) {
				throttle(`guest:${ip}`, 5, 86400000);
				const id = randomUUID();
				db.prepare("INSERT INTO users VALUES(?,NULL,NULL,?)").run(id, Date.now());
				session(res, id);
				u = db.prepare("SELECT * FROM users WHERE id=?").get(id);
			}
			return json(res, 200, status(u));
		}
		if (path === "/api/account-link" && req.method === "POST") {
			throttle(`account-link:${ip}`, 5, 600000);
			const b = await body(req);
			if (!["reset", "verify"].includes(b.purpose)) fail(400, "Invalid link request.");
			if (!mailReady(env)) fail(503, "Account email is not configured yet.");
			const email = b.purpose === "verify" ? u?.email : (typeof b.email === "string" ? b.email.trim().toLowerCase() : "");
			if (!email || email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) fail(400, "Enter a valid email address.");
			throttle(`account-link-email:${hash(email)}`, 3, 600000);
			const target = db.prepare("SELECT * FROM users WHERE email=?").get(email);
			if (target && (b.purpose !== "verify" || !emailVerified(db, target))) {
				const token = issueToken(db, target.id, b.purpose);
				try { await sendAccountLink({ email, token, purpose: b.purpose }); }
				catch { console.error("Account email delivery failed."); }
			}
			return json(res, 202, { ok: true, message: "If the account is eligible, an email will arrive shortly." });
		}
		if (path === "/api/account-link/complete" && req.method === "POST") {
			throttle(`account-link-complete:${ip}`, 10, 600000);
			const b = await body(req);
			if (!["reset", "verify"].includes(b.purpose)) fail(400, "Invalid link request.");
			const target = tokenUser(db, b.token, b.purpose);
			const password = b.purpose === "reset" ? await passwordHash(b.password) : undefined;
			if (active.has(target.id)) fail(409, "A response is running. Try this link again when it finishes.");
			consumeToken(db, b.token, b.purpose, password);
			return json(res, 200, { ok: true });
		}
		if (path === "/api/auth" && req.method === "POST") {
			throttle(`auth:${ip}`, 10, 600000);
			const b = await body(req);
			if (
				typeof b.email !== "string" ||
				!/^\S+@\S+\.\S+$/.test(b.email) ||
				b.email.length > 254 ||
				typeof b.password !== "string" ||
				b.password.length < 12 ||
				b.password.length > 128
			)
				fail(400, "Use a valid email and a password of 12–128 characters.");
			const email = b.email.toLowerCase().trim(),
				existing = db.prepare("SELECT * FROM users WHERE email=?").get(email);
			if (!["register", "login"].includes(b.mode)) fail(400, "Invalid sign-in action.");
			if (b.mode === "register") {
				if (existing) fail(409, "An account with this email already exists.");
				const id = u && !u.email ? u.id : randomUUID(),
					salt = randomBytes(16).toString("hex"),
					derived = await scrypt(b.password, salt, 64),
					password = salt + ":" + derived.toString("hex");
				if (u && !u.email && db.prepare("SELECT email FROM users WHERE id=?").get(id)?.email !== null) fail(409, "Your account changed. Reload and try again.");
				if (u && !u.email)
					db.prepare("UPDATE users SET email=?,password=? WHERE id=?").run(email, password, id);
				else db.prepare("INSERT INTO users VALUES(?,?,?,?)").run(id, email, password, Date.now());
				const oldToken = req.headers.cookie?.match(/(?:^|; )oc_session=([^;]+)/)?.[1];
				if (oldToken) db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(oldToken));
				session(res, id);
				return json(res, 200, status(db.prepare("SELECT * FROM users WHERE id=?").get(id)));
			}
			const [salt, stored] = (existing?.password || "invalid:" + "0".repeat(128)).split(":");
			const derived = await scrypt(b.password, salt, 64);
			if (!existing || !timingSafeEqual(derived, Buffer.from(stored, "hex")) || db.prepare("SELECT password FROM users WHERE id=?").get(existing.id)?.password !== existing.password)
				fail(401, "Email or password is incorrect.");
			session(res, existing.id);
			return json(res, 200, status(existing));
		}
		if (path.startsWith("/api/") && !u) fail(401, "Your session expired. Please sign in again.");
		if (path === "/api/me" && req.method === "GET") return json(res, 200, status(u));
		if (path === "/api/models" && req.method === "GET")
			return json(
				res,
				200,
				catalog().map((m) => ({
					id: m.id,
					name: m.name,
					lab: m.lab,
					available: enabled(m),
					free: m.free,
				}))
			);
		if (path === "/api/huggingface-models" && req.method === "GET") {
			throttle(`hub:${ip}`, 30, 60000);
			const query = (url.searchParams.get("q") || "").trim(),
				cursor = url.searchParams.get("cursor") || "";
			if (
				query.length > 100 ||
				cursor.length > 500 ||
				(cursor && !/^[A-Za-z0-9_.~%-]+$/.test(cursor))
			)
				fail(400, "Invalid catalogue search.");
			return json(res, 200, await hubModels(query, cursor));
		}
		if (path === "/api/logout" && req.method === "POST") {
			const token = req.headers.cookie?.match(/(?:^|; )oc_session=([^;]+)/)?.[1];
			if (token) db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(token));
			res.setHeader("Set-Cookie", "oc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
			return json(res, 200, { ok: true });
		}
		if (path === "/api/account" && req.method === "DELETE") {
			if (active.has(u.id)) fail(409, "Stop the response before deleting your account.");
			db.prepare("DELETE FROM users WHERE id=?").run(u.id);
			res.setHeader("Set-Cookie", "oc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
			return json(res, 200, { ok: true });
		}
		if (path === "/api/apple/verify" && req.method === "POST") {
			if (!u.email) fail(403, "Create an account before subscribing.");
			const b = await body(req);
			const tx = await appleVerifier().verifyAndDecodeTransaction(b.signedTransaction);
			recordTransaction(db, tx, u.id, product);
			return json(res, 200, status(u));
		}
		if (path === "/api/chats" && req.method === "GET")
			return json(
				res,
				200,
				db
					.prepare("SELECT * FROM chats WHERE user_id=? ORDER BY updated DESC LIMIT 200")
					.all(u.id)
					.map((c) => ({ ...c, messages: JSON.parse(c.messages) }))
			);
		if (path.startsWith("/api/chats/") && req.method === "DELETE") {
			if (active.has(u.id)) fail(409, "Stop the response before deleting a conversation.");
			db.prepare("DELETE FROM chats WHERE id=? AND user_id=?").run(path.split("/").pop(), u.id);
			return json(res, 200, { ok: true });
		}
		if (path.startsWith("/api/chats/") && req.method === "PATCH") {
			const b = await body(req);
			if (active.has(u.id)) fail(409, "Stop the response before renaming a conversation.");
			const title = typeof b.title === "string" ? b.title.trim() : "";
			if (!title || title.length > 80 || /[\u0000-\u001F\u007F]/.test(title))
				fail(400, "Use a conversation name between 1 and 80 characters.");
			const result = db
				.prepare("UPDATE chats SET title=?,updated=? WHERE id=? AND user_id=?")
				.run(title, Date.now(), path.split("/").pop(), u.id);
			if (!result.changes) fail(404, "Conversation not found.");
			return json(res, 200, { ok: true, title });
		}
		if (path === "/api/chat" && req.method === "POST") {
			throttle(`chat:${u.id}`, 15);
			if (active.has(u.id)) fail(409, "Wait for the current response to finish.");
			const b = await body(req);
			if (active.has(u.id)) fail(409, "Wait for the current response to finish.");
			if (!user(req)) fail(401, "Your session expired. Please sign in again.");
			const m = catalog().find((m) => m.id === b.model);
			if (!m || !enabled(m))
				fail(503, "This model is not connected yet. Choose a connected model.");
			if (typeof b.text !== "string" || !b.text.trim() || Buffer.byteLength(b.text) > 16000)
				fail(400, "Enter a message under 16,000 bytes.");
			const byo = req.headers["x-provider-key"];
			if (byo && (!/^[\x21-\x7E]{10,512}$/.test(byo) || Array.isArray(byo)))
				fail(400, "Invalid provider key.");
			if (byo && base !== "https://openrouter.ai/api/v1")
				fail(400, "Personal OpenRouter keys require the OpenRouter provider.");
			const key = byo || env.OPENAI_API_KEY;
			if (!key) fail(503, "Chat access is not enabled yet. Please try again later.");
			const plus = isPlus(db, u.id);
			if (!byo && !plus && !m.free)
				fail(402, "This model requires Plus. Choose a free model or use your own key.");
			let chat = b.chatId
				? db.prepare("SELECT * FROM chats WHERE id=? AND user_id=?").get(b.chatId, u.id)
				: null;
			if (b.chatId && !chat) fail(404, "Conversation not found.");
			if (!chat && db.prepare("SELECT COUNT(*) AS n FROM chats WHERE user_id=?").get(u.id).n >= 200)
				fail(409, "Delete an old conversation before starting another.");
			const id = chat?.id || randomUUID(),
				messages = chat ? JSON.parse(chat.messages) : [];
			if (messages.length > 100) fail(400, "Start a new chat to continue.");
			if (b.webSearch !== undefined && typeof b.webSearch !== "boolean") fail(400, "Invalid search option.");
			if (b.webSearch) fail(400, "Web search is not enabled yet. Send without web search.");
			let attachments;
			try { attachments = validateAttachments(b.attachments); }
			catch (error) { fail(400, error.message); }
			const requestedModel = m.providerId;
			const userMessage = { role: "user", content: b.text.trim(), attachments, at: Date.now() };
			const input = [
				...messages.filter((x) => !x.failed).map(providerMessage),
				providerMessage(userMessage),
			];
			const bytes = Buffer.byteLength(JSON.stringify(input));
			if (bytes > MAX_CONTEXT_BYTES) fail(400, "This conversation is full. Start a new chat.");
			const day = new Date().toISOString().slice(0, 10),
				month = day.slice(0, 7),
				cost = Math.ceil((bytes + input.length * 32) * m.input + maxTokens * m.output);
			let reservations = [];
			if (!byo)
				reservations = reserve(db, [
					{ key: `messages:${u.id}:${day}`, amount: 1, limit: plus ? plusMessages : freeMessages },
					...(!plus ? [{ key: `ip-messages:${ip}:${day}`, amount: 1, limit: freeMessages }] : []),
					{
						key: plus ? `cost:${u.id}:${month}` : `cost:${u.id}:${day}`,
						amount: cost,
						limit: plus ? n("PLUS_MONTHLY_MICRO_USD", 10000000) : n("FREE_DAILY_MICRO_USD", 100000),
					},
					{
						key: `global:${day}`,
						amount: cost,
						limit: n("GLOBAL_DAILY_MICRO_USD", 20000000),
						message: "Chat is at capacity. Please try again later.",
					},
				]);
			active.add(u.id);
			let started = false,
				answer = "",
				usage = null,
				controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 120000);
			res.on("close", () => {
				if (!res.writableEnded) controller.abort();
			});
			try {
				const client = new OpenAI({ baseURL: base, apiKey: key, maxRetries: 0, timeout: 120000 });
				const stream = await client.chat.completions.create(
					{
						model: requestedModel,
						messages: input,
						stream: true,
						max_tokens: maxTokens,
						stream_options: { include_usage: true },
						...(base === "https://openrouter.ai/api/v1"
							? {
									reasoning: {
										...(m.reasoningEffort ? { effort: m.reasoningEffort } : {}),
										exclude: true,
									},
									provider: {
										require_parameters: true,
										max_price: { prompt: m.input, completion: m.output },
									},
								}
							: {}),
					},
					{ signal: controller.signal }
				);
				started = true;
				res.writeHead(200, {
					"Content-Type": "application/x-ndjson",
					"Cache-Control": "no-store",
					"X-Accel-Buffering": "no",
				});
				res.write(JSON.stringify({ type: "start", chatId: id }) + "\n");
				messages.push(userMessage);
				// Persist the user's turn before streaming so an empty/aborted response
				// still leaves a valid conversation that can be continued.
				db.prepare(
					"INSERT INTO chats VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,messages=excluded.messages,updated=excluded.updated"
				).run(
					id,
					u.id,
					chat?.title || b.text.trim().slice(0, 70),
					m.id,
					JSON.stringify(messages),
					Date.now()
				);

				async function* tracked() {
					for await (const chunk of stream) {
						if (chunk.usage) usage = chunk.usage;
						yield chunk;
					}
				}
				for await (const update of openAIChatToTextGenerationStream(tracked())) {
					const delta = update.token?.text || "";
					answer += delta;
					if (Buffer.byteLength(answer) > 200000) {
						controller.abort();
						throw new Error("Response exceeded the size limit.");
					}
					if (!res.destroyed) res.write(JSON.stringify({ type: "delta", text: delta }) + "\n");
				}
				if (!answer.trim()) throw new Error("The model returned an empty response.");
				messages.push({ role: "assistant", content: answer, model: m.name, at: Date.now() });
				db.prepare(
					"INSERT INTO chats VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,messages=excluded.messages,updated=excluded.updated"
				).run(
					id,
					u.id,
					chat?.title || b.text.trim().slice(0, 70),
					m.id,
					JSON.stringify(messages),
					Date.now()
				);
				if (!res.destroyed) res.end(JSON.stringify({ type: "done", chatId: id }) + "\n");
			} catch (e) {
				if (!started) {
					refund(db, reservations);
					fail(502, "The model could not be reached. Your allowance was not used.");
				}
				if (answer) {
					messages.push({
						role: "assistant",
						content: answer,
						model: m.name,
						at: Date.now(),
						failed: true,
					});
					db.prepare(
						"INSERT INTO chats VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,messages=excluded.messages,updated=excluded.updated"
					).run(
						id,
						u.id,
						chat?.title || b.text.trim().slice(0, 70),
						m.id,
						JSON.stringify(messages),
						Date.now()
					);
				}
				if (!res.destroyed)
					res.end(
						JSON.stringify({
							type: "error",
							message: "The response was interrupted. Please try again.",
						}) + "\n"
					);
			} finally {
				if (
					started &&
					usage &&
					Number.isFinite(usage.prompt_tokens) &&
					Number.isFinite(usage.completion_tokens)
				) {
					const used = Math.ceil(
						usage.prompt_tokens * m.input + usage.completion_tokens * m.output
					);
					if (used >= 0 && used < cost)
						refund(
							db,
							reservations
								.filter((e) => e.key.startsWith("cost:") || e.key.startsWith("global:"))
								.map((e) => ({ ...e, amount: cost - used }))
						);
				}
				clearTimeout(timer);
				active.delete(u.id);
			}
			return;
		}
		if (path.startsWith("/api/")) fail(404, "Not found.");
		if (req.method !== "GET" && req.method !== "HEAD") fail(405, "Method not allowed.");
		const root = resolve("dist");
		let file = resolve(root, "." + decodeURIComponent(path));
		if (!file.startsWith(root + "/") && file !== root) fail(403, "Forbidden");
		try {
			if (!(await stat(file)).isFile()) file = resolve(root, "index.html");
		} catch {
			file = resolve(root, "index.html");
		}
		const bytes = await readFile(file);
		const mime = {
			".html": "text/html",
			".js": "text/javascript",
			".css": "text/css",
			".svg": "image/svg+xml",
			".woff2": "font/woff2",
			".woff": "font/woff",
			".ttf": "font/ttf",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".png": "image/png",
			".webp": "image/webp",
			".mp4": "video/mp4",
			".webm": "video/webm",
			".mov": "video/quicktime",
		};
		const headers = {
			"Content-Type": mime[extname(file)] || "application/octet-stream",
			"Cache-Control": extname(file) === ".html" ? "no-cache" : "public,max-age=3600",
			"Accept-Ranges": "bytes",
		};
		// Byte ranges let Safari/iOS stream the background videos.
		const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
		if (range && (range[1] || range[2])) {
			const size = bytes.length;
			const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
			const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
			if (start >= size || start > end) {
				res.writeHead(416, { "Content-Range": `bytes */${size}` });
				return res.end();
			}
			res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` });
			return res.end(req.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
		}
		res.writeHead(200, headers);
		res.end(req.method === "HEAD" ? undefined : bytes);
	} catch (e) {
		if (res.headersSent) {
			if (!res.destroyed) res.end();
			return;
		}
		const code = e.status || 500;
		json(res, code, {
			error: code === 500 ? "Something went wrong. Please try again." : e.message,
		});
	}
});
server.listen(port, env.HOST || "0.0.0.0", () => console.log(`Open Chat listening on ${port}`));
