export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 64000;
export const MAX_ATTACHMENT_BYTES = 80000;
export const MAX_CONTEXT_BYTES = 100000;
export const textBytes = (text) => new TextEncoder().encode(text).length;
export const isTextFile = (name, type) => /^(text\/|application\/(json|csv|xml)$)/.test(type) || /\.(txt|md|csv|json|xml)$/i.test(name);

export function validateAttachments(value = []) {
	if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error("Attach up to four text files.");
	let total = 0;
	return value.map((file) => {
		if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 200 || /[\u0000-\u001f\u007f]/.test(file.name) || typeof file.type !== "string")
			throw new Error("Invalid attachment name or type.");
		if (file.type.startsWith("image/") || file.data !== undefined)
			throw new Error("Image uploads are not enabled yet. Attach a text file instead.");
		if (!isTextFile(file.name, file.type) || typeof file.text !== "string")
			throw new Error("Choose a TXT, Markdown, CSV, JSON or XML file.");
		const size = textBytes(file.text);
		if (size > MAX_FILE_BYTES) throw new Error("Each text file must be 64 KB or smaller.");
		total += size;
		if (total > MAX_ATTACHMENT_BYTES) throw new Error("Attached files must total 80 KB or less.");
		return { name: file.name.trim(), type: file.type || "text/plain", text: file.text };
	});
}
export function providerMessage(message) {
	const files = validateAttachments(message.attachments);
	return {
		role: message.role,
		content: files.length ? [
			{ type: "text", text: message.content },
			...files.map((file) => ({ type: "text", text: `[Attached file: ${file.name}]\n${file.text}` })),
		] : message.content,
	};
}
