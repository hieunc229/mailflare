import assert from "node:assert/strict";
import test from "node:test";
import { loadApp } from "./helpers/real-db.mjs";

const { app, newDatabase } = await loadApp("recovery-codes", `
	export { issueRecoveryCodes, consumeRecoveryCode, countUnusedRecoveryCodes, normalizeRecoveryCode } from "./src/lib/auth/recovery-codes.ts";
`);

const seed = (t) => newDatabase(t, "INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u1', 'u1@example.com', 'x', 'U', 'user', 1);");

test("normalizeRecoveryCode drops case, spaces and hyphens", () => {
	assert.equal(app.normalizeRecoveryCode("ABCDE-FGHJK"), "abcdefghjk");
});

test("a code is accepted in any spacing and case", async (t) => {
	const { env } = await seed(t);
	const [code] = await app.issueRecoveryCodes(env, "u1");
	const variant = code.toUpperCase().replace("-", " ");
	assert.equal(await app.consumeRecoveryCode(env, "u1", variant), true);
});

test("issuing returns eight codes and counts them as unused", async (t) => {
	const { env } = await seed(t);
	const codes = await app.issueRecoveryCodes(env, "u1");
	assert.equal(codes.length, 8);
	assert.equal(await app.countUnusedRecoveryCodes(env, "u1"), 8);
});

test("a code works once even when two requests read it as unused", async (t) => {
	const { env } = await seed(t);
	const [code] = await app.issueRecoveryCodes(env, "u1");
	// Hold each lookup's result until both requests have read the code as unused, so the update is what decides.
	const waiting = [];
	let open = false;
	const held = async (run) => {
		const result = await run();
		if (open) return result;
		await new Promise((resolve) => {
			waiting.push(resolve);
			if (waiting.length === 2) { open = true; waiting.forEach((release) => release()); }
		});
		return result;
	};
	const gated = new Proxy(env.DB, {
		get(target, key) {
			const value = target[key];
			if (key !== "prepare") return typeof value === "function" ? value.bind(target) : value;
			return (sql) => {
				const statement = target.prepare(sql);
				if (!/^\s*select/i.test(sql)) return statement;
				return new Proxy(statement, {
					get(inner, name) {
						const member = inner[name];
						if (name === "bind") return (...values) => new Proxy(inner.bind(...values), { get(bound, method) { const fn = bound[method]; return ["all", "raw", "first"].includes(method) ? (...args) => held(() => fn.apply(bound, args)) : typeof fn === "function" ? fn.bind(bound) : fn; } });
						return typeof member === "function" ? member.bind(inner) : member;
					},
				});
			};
		},
	});
	const racing = { DB: gated };
	const results = await Promise.all([app.consumeRecoveryCode(racing, "u1", code), app.consumeRecoveryCode(racing, "u1", code)]);
	assert.equal(open, true, "both lookups overlapped");
	assert.deepEqual(results.sort(), [false, true]);
	assert.equal(await app.countUnusedRecoveryCodes(env, "u1"), 7);
});

test("issuing a new set invalidates the old one", async (t) => {
	const { env } = await seed(t);
	const [oldCode] = await app.issueRecoveryCodes(env, "u1");
	await app.issueRecoveryCodes(env, "u1");
	assert.equal(await app.consumeRecoveryCode(env, "u1", oldCode), false);
	assert.equal(await app.countUnusedRecoveryCodes(env, "u1"), 8);
});

test("another user's code is refused", async (t) => {
	const { env, sqlite } = await seed(t);
	sqlite.exec("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u2', 'u2@example.com', 'x', 'V', 'user', 1)");
	const [code] = await app.issueRecoveryCodes(env, "u1");
	assert.equal(await app.consumeRecoveryCode(env, "u2", code), false);
});
