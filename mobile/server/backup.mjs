import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, chmod, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const source = resolve(process.env.DATABASE_PATH || "./data/open-chat.sqlite");
const destination = resolve(
	process.argv[2] || `./backups/open-chat-${new Date().toISOString().replaceAll(":", "-")}.sqlite`
);
if (source === destination)
	throw new Error("Backup must use a different file from the live database.");
await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
// Reserve a private destination without overwriting an existing backup.
const { open } = await import("node:fs/promises");
const reserved = await open(destination, "wx", 0o600);
await reserved.close();
let db;
try {
	db = new DatabaseSync(source, { readOnly: true });
	await backup(db, destination);
	await chmod(destination, 0o600);
	const copy = new DatabaseSync(destination, { readOnly: true });
	try {
		if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
			throw new Error("Backup integrity check failed.");
	} finally {
		copy.close();
	}
	console.log(`Verified backup: ${destination}`);
} catch (error) {
	await rm(destination, { force: true });
	throw error;
} finally {
	db?.close();
}
