import { randomBytes, createHash, scrypt as derive } from "node:crypto";
import { promisify } from "node:util";
import { atomic } from "./store.mjs";
const scrypt = promisify(derive);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const invalid = () => Object.assign(new Error("This link is invalid or expired. Request a new one."), { status: 400 });
export function initAccountTokens(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS account_tokens(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,purpose TEXT NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS verified_emails(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,email TEXT NOT NULL,verified INTEGER NOT NULL);`);
}
export async function passwordHash(password) {
	if (typeof password !== "string" || password.length < 12 || password.length > 128)
		throw Object.assign(new Error("Use a password of 12–128 characters."), { status: 400 });
	const salt = randomBytes(16).toString("hex");
	return salt + ":" + (await scrypt(password, salt, 64)).toString("hex");
}
export function issueToken(db, userId, purpose, now = Date.now()) {
	if (!["reset", "verify"].includes(purpose)) throw new Error("Invalid token purpose.");
	const token = randomBytes(32).toString("hex");
	atomic(db, () => {
		db.prepare("DELETE FROM account_tokens WHERE expires<=? OR (user_id=? AND purpose=?)").run(now, userId, purpose);
		db.prepare("INSERT INTO account_tokens VALUES(?,?,?,?)").run(digest(token), userId, purpose, now + (purpose === "reset" ? 1800000 : 86400000));
	});
	return token;
}
export function tokenUser(db, token, purpose, now = Date.now()) {
	if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw invalid();
	const row = db.prepare("SELECT users.* FROM account_tokens JOIN users ON users.id=account_tokens.user_id WHERE hash=? AND purpose=? AND expires>?").get(digest(token), purpose, now);
	if (!row?.email) throw invalid();
	return row;
}
export function consumeToken(db, token, purpose, password, now = Date.now()) {
	return atomic(db, () => {
		const u = tokenUser(db, token, purpose, now);
		if (purpose === "reset") {
			if (typeof password !== "string" || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(password)) throw new Error("A derived password is required.");
			db.prepare("UPDATE users SET password=? WHERE id=?").run(password, u.id);
			db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
			db.prepare("DELETE FROM account_tokens WHERE user_id=?").run(u.id);
		} else {
			db.prepare("DELETE FROM account_tokens WHERE hash=?").run(digest(token));
		}
		db.prepare("INSERT INTO verified_emails VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,verified=excluded.verified").run(u.id, u.email, now);
		return u.id;
	});
}
export function emailVerified(db, u) {
	return !!db.prepare("SELECT 1 FROM verified_emails WHERE user_id=? AND email=?").get(u.id, u.email);
}
