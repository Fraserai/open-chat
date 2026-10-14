import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
export function mailReady(env = process.env) {
	return env.MAIL_TRANSPORT === "resend" ? !!env.RESEND_API_KEY && !!env.MAIL_FROM : env.MAIL_TRANSPORT === "file" && env.NODE_ENV !== "production";
}
export async function sendAccountLink({ email, token, purpose }, env = process.env, request = fetch) {
	if (!mailReady(env)) throw Object.assign(new Error("Account email is not configured yet."), { status: 503 });
	const url = new URL(env.APP_ORIGIN || "http://localhost:3001");
	url.hash = new URLSearchParams({ action: purpose, token }).toString();
	const action = purpose === "reset" ? "Reset your password" : "Verify your email";
	const message = {
		from: env.MAIL_FROM,
		to: [email],
		subject: `${action} — Open Chat`,
		text: `${action}:\n${url}\n\nThis link expires in ${purpose === "reset" ? "30 minutes" : "24 hours"} and works once. If you did not request it, ignore this email.`,
	};
	if (env.MAIL_TRANSPORT === "file") {
		const directory = resolve(env.MAIL_OUTBOX_PATH || "./data/mail-outbox");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(resolve(directory, `${randomUUID()}.json`), JSON.stringify(message), { mode: 0o600, flag: "wx" });
		return;
	}
	const response = await request("https://api.resend.com/emails", {
		method: "POST",
		headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify(message), signal: AbortSignal.timeout(10000),
	});
	if (!response.ok) throw new Error("Account email could not be delivered.");
}
