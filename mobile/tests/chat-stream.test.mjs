import test from "node:test";
import assert from "node:assert/strict";
import { readChatStream } from "../src/chatStream.ts";

const start = { type: "start", chatId: "chat-1" };
const delta = { type: "delta", text: "Hello 👋 café" };
const done = { type: "done", chatId: "chat-1" };
function stream(events, { trailingNewline = true, bytewise = false } = {}) {
	const bytes = new TextEncoder().encode(events.map(JSON.stringify).join("\n") + (trailingNewline ? "\n" : ""));
	return new ReadableStream({
		start(controller) {
			if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
			else controller.enqueue(bytes);
			controller.close();
		},
	});
}

test("stream preserves Unicode across byte boundaries and accepts a final line without newline", async () => {
	const events = [];
	const body = stream([start, delta, done], { trailingNewline: false, bytewise: true });
	await readChatStream(body, (event) => events.push(event));
	assert.deepEqual(events, [start, delta, done]);
	assert.equal(body.locked, false);
});

test("truncated replies retain partial content and report interruption", async () => {
	const events = [];
	const body = stream([start, delta]);
	await assert.rejects(readChatStream(body, (event) => events.push(event)), /before the response finished/);
	assert.deepEqual(events, [start, delta]);
	assert.equal(body.locked, false);
});

test("provider errors are surfaced and malformed event sequences are rejected", async () => {
	await assert.rejects(readChatStream(stream([start, { type: "error", message: "Try again." }]), () => {}), /Try again/);
	for (const events of [[delta, done], [start, start], [start, { ...done, chatId: "wrong" }], [start, null]]) {
		await assert.rejects(readChatStream(stream(events), () => {}), /invalid response stream/);
	}
	await assert.rejects(readChatStream(null, () => {}), /unavailable/);
});

test("completion cancels the reader without waiting for the connection to close", async () => {
	let cancelled = false;
	const body = new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode([start, delta, done].map(JSON.stringify).join("\n") + "\n"));
		},
		cancel() { cancelled = true; },
	});
	await readChatStream(body, () => {});
	assert.equal(cancelled, true);
	assert.equal(body.locked, false);
});
