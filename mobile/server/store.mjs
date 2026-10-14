import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function openStore(file) {
	if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE,password TEXT,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires INTEGER);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,title TEXT,model TEXT,messages TEXT,updated INTEGER);
CREATE TABLE IF NOT EXISTS buckets(key TEXT PRIMARY KEY,used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS owners(original_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,original_id TEXT NOT NULL,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,product TEXT,expires INTEGER,revoked INTEGER,signed INTEGER);
CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER,expires INTEGER);
`);
	return db;
}
export function atomic(db, fn) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const r = fn();
		db.exec("COMMIT");
		return r;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
export function reserve(db, entries) {
	return atomic(db, () => {
		for (const e of entries) {
			const row = db.prepare("SELECT used FROM buckets WHERE key=?").get(e.key);
			if ((row?.used || 0) + e.amount > e.limit)
				throw Object.assign(
					new Error(e.message || "Your allowance has been used. Try again after it resets."),
					{ status: 429 }
				);
		}
		for (const e of entries)
			db.prepare(
				"INSERT INTO buckets(key,used) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET used=used+excluded.used"
			).run(e.key, e.amount);
		return entries;
	});
}
export function refund(db, entries) {
	atomic(db, () => {
		for (const e of entries)
			db.prepare("UPDATE buckets SET used=MAX(0,used-?) WHERE key=?").run(e.amount, e.key);
	});
}
export function recordTransaction(db, tx, userId, product) {
	if (
		tx.productId !== product ||
		!tx.transactionId ||
		!tx.originalTransactionId ||
		!tx.signedDate ||
		tx.appAccountToken?.toLowerCase() !== userId.toLowerCase()
	)
		throw Object.assign(new Error("This purchase does not belong to this account."), {
			status: 403,
		});
	return atomic(db, () => {
		const owner = db
			.prepare("SELECT user_id FROM owners WHERE original_id=?")
			.get(tx.originalTransactionId);
		if (owner && owner.user_id !== userId)
			throw Object.assign(new Error("Purchase already linked to another account."), {
				status: 409,
			});
		db.prepare("INSERT OR IGNORE INTO owners VALUES(?,?)").run(tx.originalTransactionId, userId);
		db.prepare(
			`INSERT INTO transactions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET expires=excluded.expires,revoked=excluded.revoked,signed=excluded.signed WHERE excluded.signed>transactions.signed`
		).run(
			tx.transactionId,
			tx.originalTransactionId,
			userId,
			tx.productId,
			tx.expiresDate || 0,
			tx.revocationDate || 0,
			tx.signedDate
		);
	});
}
export function isPlus(db, userId) {
	return !!db
		.prepare("SELECT id FROM transactions WHERE user_id=? AND expires>? AND revoked=0 LIMIT 1")
		.get(userId, Date.now());
}
