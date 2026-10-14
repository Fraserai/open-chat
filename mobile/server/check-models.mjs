// Read-only deployment check. Never logs API keys or writes mappings automatically.
import { loadCatalog, enabled } from "./catalog.mjs";
const base = process.env.OPENAI_BASE_URL || "https://openrouter.ai/api/v1";
if (!["https://openrouter.ai/api/v1", "https://router.huggingface.co/v1"].includes(base))
	throw new Error("Unapproved provider URL");
const response = await fetch(base + "/models", {
	headers: process.env.OPENAI_API_KEY
		? { Authorization: "Bearer " + process.env.OPENAI_API_KEY }
		: {},
	signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error("Provider catalog returned " + response.status);
const { data } = await response.json();
const listings = new Map(data.map((m) => [m.id, m]));
let failed = false;
for (const m of loadCatalog(process.env.MODEL_MAP_PATH || "./model-map.json")) {
	const listing = listings.get(m.providerId);
	const found = enabled(m) && !!listing;
	console.log(
		`${found ? "OK" : "NOT CONNECTED"} ${m.name}${m.providerId ? " → " + m.providerId : ""}`
	);
	if (enabled(m) && !found) failed = true;
	if (found && base === "https://openrouter.ai/api/v1") {
		const prompt = Number(listing.pricing?.prompt) * 1_000_000;
		const completion = Number(listing.pricing?.completion) * 1_000_000;
		if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) {
			console.log("  PRICE UNKNOWN: cannot verify configured caps");
			failed = true;
		} else if (prompt > m.input + 1e-9 || completion > m.output + 1e-9) {
			console.log(`  PRICE ABOVE CAP: published ${prompt}/${completion}, configured ${m.input}/${m.output} USD per million prompt/completion tokens`);
			failed = true;
		}
	}
}
if (failed) process.exitCode = 1;
