import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
export async function fixture(overrides = {}) {
	const temp = await mkdtemp(tmpdir() + "/open-chat-fixture-");
	const calls = [];
	const provider = createServer(async (req, res) => {
		let raw = "";
		for await (const c of req) raw += c;
		const data = JSON.parse(raw);
		calls.push(data);
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const event = (text) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
		event("Fixture reply 👋");
		if (JSON.stringify(data.messages.at(-1)).includes("slow reply")) await new Promise((r) => setTimeout(r, 500));
		if (!res.destroyed) res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`);
	});
	provider.listen(0, "127.0.0.1");
	await once(provider, "listening");
	await writeFile(temp + "/models.json", JSON.stringify({ "glm-53": { providerId: "fixture-model", inputPerMillion: 1, outputPerMillion: 1, openWeightsVerified: true, free: true } }));
	const probe = createServer().listen(0, "127.0.0.1");
	await once(probe, "listening");
	const port = probe.address().port;
	await new Promise((r) => probe.close(r));
	const origin = `http://127.0.0.1:${port}`;
	const child = spawn(process.execPath, ["server/index.mjs"], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, NODE_ENV: "test", PORT: String(port), APP_ORIGIN: origin, DATABASE_PATH: temp + "/db.sqlite", MODEL_MAP_PATH: temp + "/models.json", OPENAI_API_KEY: "fixture-key", OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, TEST_PROVIDER: "1", FREE_DAILY_MESSAGES: "100", FREE_DAILY_MICRO_USD: "10000000", MAIL_TRANSPORT: "file", MAIL_OUTBOX_PATH: temp + "/outbox", ...overrides },
	});
	let logs = "";
	child.stdout.on("data", (x) => logs += x);
	child.stderr.on("data", (x) => logs += x);
	const close = async () => {
		if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; }
		provider.closeAllConnections();
		await new Promise((r) => provider.close(r));
		await rm(temp, { recursive: true, force: true });
	};
	try {
		for (let i = 0; !logs.includes("listening"); i++) {
			if (i > 100 || child.exitCode !== null) throw new Error(logs || "Server did not start.");
			await new Promise((r) => setTimeout(r, 50));
		}
	} catch (e) { await close(); throw e; }
	let cookie = "";
	async function request(path, data, method = data === undefined ? "GET" : "POST", session = cookie) {
		const response = await fetch(`${origin}/api/${path}`, { method, headers: { Origin: origin, "Content-Type": "application/json", Cookie: session }, body: data === undefined ? undefined : JSON.stringify(data) });
		if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
		return response;
	}
	return { origin, port, temp, calls, request, close, get cookie() { return cookie; } };
}
