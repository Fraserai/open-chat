import test from "node:test";
import assert from "node:assert/strict";
import { openStore, reserve, refund, recordTransaction, isPlus } from "../server/store.mjs";
const create = () => {
	const db = openStore(":memory:");
	db.prepare("INSERT INTO users VALUES(?,?,NULL,?)").run("user-a", "a@example.test", Date.now());
	db.prepare("INSERT INTO users VALUES(?,?,NULL,?)").run("user-b", "b@example.test", Date.now());
	return db;
};
test("quota reservations are atomic across message and spend limits", () => {
	const db = create();
	reserve(db, [
		{ key: "messages", amount: 1, limit: 3 },
		{ key: "cost", amount: 40, limit: 50 },
	]);
	assert.throws(
		() =>
			reserve(db, [
				{ key: "messages", amount: 1, limit: 3 },
				{ key: "cost", amount: 40, limit: 50 },
			]),
		/allowance/
	);
	assert.equal(db.prepare("SELECT used FROM buckets WHERE key=?").get("messages").used, 1);
	refund(db, [
		{ key: "messages", amount: 1 },
		{ key: "cost", amount: 40 },
	]);
	assert.equal(db.prepare("SELECT used FROM buckets WHERE key=?").get("cost").used, 0);
	db.close();
});
test("purchase identity, expiry, replay and revocation cannot grant false Plus", () => {
	const db = create();
	const tx = {
		productId: "plus",
		transactionId: "1",
		originalTransactionId: "original",
		appAccountToken: "user-a",
		expiresDate: Date.now() + 100000,
		signedDate: 100,
	};
	assert.throws(() => recordTransaction(db, tx, "user-b", "plus"));
	assert.throws(() => recordTransaction(db, tx, "user-a", "other"));
	recordTransaction(db, tx, "user-a", "plus");
	assert.equal(isPlus(db, "user-a"), true);
	recordTransaction(db, { ...tx, revocationDate: 200, signedDate: 200 }, "user-a", "plus");
	assert.equal(isPlus(db, "user-a"), false);
	recordTransaction(db, tx, "user-a", "plus");
	assert.equal(isPlus(db, "user-a"), false);
	assert.throws(() =>
		recordTransaction(db, { ...tx, appAccountToken: "user-b" }, "user-b", "plus")
	);
	recordTransaction(
		db,
		{ ...tx, transactionId: "2", expiresDate: Date.now() - 1, signedDate: 300 },
		"user-a",
		"plus"
	);
	assert.equal(isPlus(db, "user-a"), false);
	db.close();
});
