import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fixture } from "./fixture.mjs";
import { validateAttachments } from "../shared/attachments.mjs";
const file = { name: "notes.txt", type: "text/plain", text: "The project colour is violet." };
const chat = (text, attachments, chatId) => ({ model: "glm-53", text, attachments, chatId });

test("request text preserves Unicode split across network chunks", async () => {
	const app = await fixture();
	try {
		await app.request("session", {});
		const text = "Hello 👋 café 世界";
		const bytes = Buffer.from(JSON.stringify(chat(text)));
		const split = bytes.indexOf(Buffer.from("👋")) + 1;
		await new Promise((resolve, reject) => {
			const req = httpRequest(app.origin + "/api/chat", { method: "POST", headers: { Origin: app.origin, Cookie: app.cookie, "Content-Type": "application/json" } }, (res) => {
				res.resume();
				res.on("end", () => res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
			});
			req.on("error", reject);
			req.write(bytes.subarray(0, split));
			setTimeout(() => req.end(bytes.subarray(split)), 30);
		});
		assert.equal(app.calls[0].messages[0].content, text);
		assert.equal((await (await app.request("chats")).json())[0].messages[0].content, text);
	} finally { await app.close(); }
});

test("attachments survive saved history and follow-ups; unsupported features consume no requests", async () => {
	const app = await fixture();
	try {
		await app.request("session", {});
		for (const data of [chat("hi", [{ ...file, text: "x".repeat(64001) }]), chat("hi", [{ name: "photo.png", type: "image/png", data: "AAAA" }]), { ...chat("hi"), webSearch: true }]) {
			assert.equal((await app.request("chat", data)).status, 400);
		}
		assert.equal(app.calls.length, 0);
		assert.equal((await (await app.request("me")).json()).used, 0);
		let response = await app.request("chat", chat("Read this", [file]));
		assert.equal(response.status, 200);
		const events = (await response.text()).trim().split("\n").map(JSON.parse);
		const id = events[0].chatId;
		assert.deepEqual((await (await app.request("chats")).json())[0].messages[0].attachments, [file]);
		response = await app.request("chat", chat("What colour?", [], id));
		await response.text();
		assert.equal(app.calls[1].messages[0].content[1].text, "[Attached file: notes.txt]\n" + file.text);
		assert.equal(app.calls[1].messages.at(-1).content, "What colour?");
		assert.throws(() => validateAttachments([{ ...file, text: "é".repeat(32001) }]), /64 KB/);
	} finally { await app.close(); }
});

test("email verification and password reset work through real HTTP; reset revokes old sessions", async () => {
	const app = await fixture();
	try {
		await app.request("session", {});
		await app.request("auth", { mode: "register", email: "person@example.test", password: "old-password-strong" });
		const originalSession = app.cookie;
		const link = async (purpose) => {
			const before = new Set(await readdir(app.temp + "/outbox").catch(() => []));
			assert.equal((await app.request("account-link", { purpose, email: "person@example.test" })).status, 202);
			const added = (await readdir(app.temp + "/outbox")).find((name) => !before.has(name));
			const mail = JSON.parse(await readFile(app.temp + "/outbox/" + added, "utf8"));
			const url = new URL(mail.text.split("\n")[1]);
			return new URLSearchParams(url.hash.slice(1)).get("token");
		};
		const verification = await link("verify");
		assert.equal((await app.request("account-link/complete", { purpose: "verify", token: verification })).status, 200);
		assert.equal((await (await app.request("me")).json()).emailVerified, true);
		assert.equal((await app.request("account-link/complete", { purpose: "verify", token: verification })).status, 400);
		const reset = await link("reset");
		assert.equal((await app.request("account-link/complete", { purpose: "reset", token: reset, password: "new-password-strong" })).status, 200);
		assert.equal((await app.request("me", undefined, "GET", originalSession)).status, 401);
		assert.equal((await app.request("account-link/complete", { purpose: "reset", token: reset, password: "other-password-strong" })).status, 400);
		assert.equal((await app.request("auth", { mode: "login", email: "person@example.test", password: "old-password-strong" })).status, 401);
		assert.equal((await app.request("auth", { mode: "login", email: "person@example.test", password: "new-password-strong" })).status, 200);
	} finally { await app.close(); }
});

test("malformed URLs return 400 without terminating the service", async () => {
	const app = await fixture();
	try {
		const status = await new Promise((resolve, reject) => {
			const req = httpRequest({ hostname: "127.0.0.1", port: app.port, path: "//[/" }, (res) => { res.resume(); resolve(res.statusCode); });
			req.on("error", reject); req.end();
		});
		assert.equal(status, 400);
		assert.equal((await app.request("health")).status, 200);
	} finally { await app.close(); }
});

test("concurrent generations and deletions cannot race a running response", async () => {
	const app = await fixture();
	try {
		await app.request("session", {});
		const first = await app.request("chat", chat("slow reply"));
		assert.equal(first.status, 200);
		assert.equal((await app.request("chat", chat("second"))).status, 409);
		assert.equal((await app.request("account", {}, "DELETE")).status, 409);
		assert.equal((await app.request("chats/arbitrary", {}, "DELETE")).status, 409);
		await first.text();
		assert.equal(app.calls.length, 1);
	} finally { await app.close(); }
});
