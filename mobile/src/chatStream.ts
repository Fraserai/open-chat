export type ChatEvent =
	| { type: "start"; chatId: string }
	| { type: "delta"; text: string }
	| { type: "done"; chatId: string };

/** Consume the gateway's newline-delimited stream, including a final unterminated line. */
export async function readChatStream(
	body: ReadableStream<Uint8Array> | null,
	onEvent: (event: ChatEvent) => void
) {
	if (!body) throw new Error("The response stream is unavailable.");
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let chatId: string | undefined;
	let finished = false;
	function consume(line: string) {
		if (!line.trim()) return;
		const event = JSON.parse(line);
		if (event?.type === "error")
			throw new Error(typeof event.message === "string" ? event.message : "The response was interrupted.");
		if (event?.type === "start" && !chatId && typeof event.chatId === "string" && event.chatId) {
			chatId = event.chatId;
		} else if (event?.type === "delta" && chatId && typeof event.text === "string") {
			// Deltas belong to the conversation established by the start event.
		} else if (event?.type === "done" && chatId && event.chatId === chatId) {
			finished = true;
		} else {
			throw new Error("The server sent an invalid response stream.");
		}
		onEvent(event);
	}
	try {
		while (!finished) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			let newline;
			while (!finished && (newline = buffer.indexOf("\n")) >= 0) {
				consume(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
			if (done) {
				if (!finished) consume(buffer);
				break;
			}
		}
		if (!finished) throw new Error("Connection ended before the response finished.");
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
