import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
const root = new URL("..", import.meta.url).pathname;
test("guest chat streams, persists, checks ownership, refunds errors and enforces quotas", async () => {
	const temp = await mkdtemp(tmpdir() + "/open-chat-test-");
	let calls = 0;
	const provider = createServer(async (req, res) => {
		let body = "";
		for await (const c of req) body += c;
		const b = JSON.parse(body);
		calls++;
		if (b.messages.at(-1).content === "fail") {
			res.writeHead(503);
			res.end("{}");
			return;
		}
		assert.equal(req.headers.authorization, "Bearer server-test-key");
		assert.equal(b.model, "fixture-model");
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const chunk of ["Hello ", "from a test fixture."])
			res.write(
				"data: " +
					JSON.stringify({
						id: "test",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
					}) +
					"\n\n"
			);
		res.end(
			"data: " +
				JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
				"\n\ndata: [DONE]\n\n"
		);
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	const modelMap = temp + "/models.json";
	await writeFile(
		modelMap,
		JSON.stringify({
			"glm-53": {
				providerId: "fixture-model",
				inputPerMillion: 1,
				outputPerMillion: 1,
				openWeightsVerified: true,
				free: true,
			},
			"kimi-k3": {
				providerId: "paid-fixture",
				inputPerMillion: 1,
				outputPerMillion: 1,
				openWeightsVerified: true,
				free: false,
			},
		})
	);
	const probe = createServer();
	probe.listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = probe.address().port;
	await new Promise((r) => probe.close(r));
	const origin = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, ["server/index.mjs"], {
		cwd: root,
		env: {
			...process.env,
			PORT: String(port),
			APP_ORIGIN: origin,
			DATABASE_PATH: temp + "/db.sqlite",
			MODEL_MAP_PATH: modelMap,
			OPENAI_API_KEY: "server-test-key",
			OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`,
			TEST_PROVIDER: "1",
			NODE_ENV: "test",
			FREE_DAILY_MESSAGES: "2",
			FREE_DAILY_MICRO_USD: "1000000",
		},
	});
	let logs = "";
	child.stdout.on("data", (x) => (logs += x));
	child.stderr.on("data", (x) => (logs += x));
	try {
		await new Promise((resolve, reject) => {
			let tries = 0;
			const check = () => {
				if (logs.includes("listening")) return resolve();
				if (++tries > 100 || child.exitCode !== null) return reject(new Error(logs));
				setTimeout(check, 50);
			};
			check();
		});
		let cookie = "";
		const request = async (
			path,
			method = "GET",
			data,
			withCookie = cookie,
			customOrigin = origin
		) =>
			fetch(origin + "/api/" + path, {
				method,
				headers: {
					"Content-Type": "application/json",
					Origin: customOrigin,
					...(withCookie ? { Cookie: withCookie } : {}),
				},
				body: data === undefined ? undefined : JSON.stringify(data),
			});
		assert.equal((await request("session", "POST", {}, "", "https://evil.example")).status, 403);
		let r = await request("session", "POST", {});
		cookie = r.headers.get("set-cookie").split(";")[0];
		const guest = await r.json();
		assert.equal(guest.plan, "free");
		assert.equal((await request("chat", "POST", { model: "not-allowed", text: "hi" })).status, 503);
		assert.equal((await request("huggingface-models?q=" + "x".repeat(101))).status, 400);
		assert.equal((await request("chat", "POST", { model: "kimi-k3", text: "hi" })).status, 402);
		assert.equal((await request("chat", "POST", { model: "glm-53", text: "fail" })).status, 502);
		assert.equal((await (await request("me")).json()).used, 0);
		r = await request("chat", "POST", { model: "glm-53", text: "hello" });
		assert.equal(r.status, 200);
		const events = (await r.text()).trim().split("\n").map(JSON.parse);
		assert.equal(
			events
				.filter((e) => e.type === "delta")
				.map((e) => e.text)
				.join(""),
			"Hello from a test fixture."
		);
		assert.equal(events.at(-1).type, "done");
		const chatId = events[0].chatId;
		const saved = await (await request("chats")).json();
		assert.equal(saved[0].messages.length, 2);
		assert.equal(
			(await request("chats/" + chatId, "PATCH", { title: "Renamed chat" })).status,
			200
		);
		assert.equal((await (await request("chats")).json())[0].title, "Renamed chat");
		const stranger = await request("session", "POST", {}, "");
		const strangerCookie = stranger.headers.get("set-cookie").split(";")[0];
		assert.equal(
			(await request("chats/" + chatId, "PATCH", { title: "Stolen" }, strangerCookie)).status,
			404
		);
		assert.equal(
			(await request("chat", "POST", { model: "glm-53", text: "steal", chatId }, strangerCookie))
				.status,
			404
		);
		r = await request("auth", "POST", {
			mode: "register",
			email: "test@example.test",
			password: "test-password-strong",
		});
		assert.equal(r.status, 200);
		cookie = r.headers.get("set-cookie").split(";")[0];
		assert.equal((await r.json()).id, guest.id);
		assert.equal((await (await request("chats")).json()).length, 1);
		r = await request("chat", "POST", { model: "glm-53", text: "again", chatId });
		assert.equal(r.status, 200);
		await r.text();
		assert.equal(
			(await request("chat", "POST", { model: "glm-53", text: "over limit", chatId })).status,
			429
		);
		assert.equal(
			(await request("apple/verify", "POST", { signedTransaction: "forged" })).status,
			503
		);
		assert.equal((await (await request("me")).json()).plan, "free");
		assert.equal((await request("account", "DELETE", {})).status, 200);
		assert.equal((await request("chats")).status, 401);
		assert.equal(calls, 3);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = once(child, "exit");
			child.kill();
			await exited;
		}
		provider.closeAllConnections();
		await new Promise((r) => provider.close(r));
		await rm(temp, { recursive: true, force: true });
	}
});
