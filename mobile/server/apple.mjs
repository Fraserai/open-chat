import { readFileSync } from "node:fs";
import { SignedDataVerifier, Environment } from "@apple/app-store-server-library";
let verifier;
export function appleVerifier() {
	if (verifier) return verifier;
	const roots = (process.env.APPLE_ROOT_CA_PATHS || "")
		.split(",")
		.filter(Boolean)
		.map((p) => readFileSync(p.trim()));
	if (!roots.length)
		throw Object.assign(new Error("Subscriptions are not enabled yet."), { status: 503 });
	const production = process.env.APPLE_ENVIRONMENT === "Production";
	if (process.env.NODE_ENV === "production" && !production)
		throw new Error("Production must verify production purchases.");
	if (production && !process.env.APPLE_APP_ID) throw new Error("APPLE_APP_ID is required.");
	verifier = new SignedDataVerifier(
		roots,
		true,
		production ? Environment.PRODUCTION : Environment.SANDBOX,
		process.env.APPLE_BUNDLE_ID || "au.openchat.app",
		production ? Number(process.env.APPLE_APP_ID) : undefined
	);
	return verifier;
}
