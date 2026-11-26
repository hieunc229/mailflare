import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-spam-engine-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({
	entryPoints: {
		engine: join(root, "src/lib/spam/engine.ts"),
		database: join(root, "server/runtime/sqlite-database.ts"),
		migrate: join(root, "server/runtime/migrate.ts"),
		db: join(root, "src/db/index.ts"),
	},
	outdir: outDir,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	tsconfig: join(root, "tsconfig.json"),
	external: ["better-sqlite3", "drizzle-orm", "drizzle-orm/*"],
	logLevel: "silent",
});

const load = (name) => import(pathToFileURL(join(outDir, `${name}.mjs`)).href);
const { analyzeSpam } = await load("engine");
const { SqliteDatabase } = await load("database");
const { applyMigrations } = await load("migrate");
const { createDb } = await load("db");

const seconds = (date) => Math.floor(date.getTime() / 1000);
const PASS = { spf: "pass", dkim: "pass", dmarc: "pass" };

async function createFixture(t) {
	const database = new SqliteDatabase(join(outDir, `${crypto.randomUUID()}.sqlite`));
	t.after(() => database.db.close());
	await applyMigrations(database, join(root, "drizzle/migrations"));
	const now = seconds(new Date());
	database.db.prepare("INSERT INTO users (id, email, name, password_hash, created_at) VALUES ('u1', 'kevin@example.com', 'Kevin', 'x', ?)").run(now);
	database.db.prepare("INSERT INTO domains (id, user_id, hostname, zone_id, created_at) VALUES ('d1', 'u1', 'example.com', 'zone', ?)").run(now);
	database.db.prepare("INSERT INTO mailboxes (id, user_id, domain_id, local_part, created_at) VALUES ('mb1', 'u1', 'd1', 'kevin', ?)").run(now);
	const addContact = (email, source) => database.db.prepare("INSERT INTO contacts (id, user_id, email, source, created_at) VALUES (?, 'u1', ?, ?, ?)").run(crypto.randomUUID(), email, source, now);
	const addReputation = (type, key, spamCount, hamCount, seen = spamCount + hamCount) => database.db.prepare(
		"INSERT INTO spam_reputation (mailbox_id, type, key, messages_seen, spam_count, ham_count, first_seen_at, last_seen_at) VALUES ('mb1', ?, ?, ?, ?, ?, ?, ?)",
	).run(type, key, seen, spamCount, hamCount, now, now);
	const analyze = (from, overrides = {}, verdicts = PASS, intelligenceProvider, headers, strictness) => analyzeSpam(createDb(database), {
		mailboxId: "mb1", userId: "u1", envelopeFrom: from, verdicts, intelligenceProvider, headers, strictness,
		message: {
			subject: "Hello", text: "Plain note.", html: null, messageId: null, fromAddr: from, toAddr: "kevin@example.com",
			ccAddr: null, bccAddr: null, replyTo: null, inReplyTo: null, references: [], date: null, attachments: [],
			...overrides,
		},
	});
	return { addContact, addReputation, analyze };
}

const ids = (result) => result.signals.map((signal) => signal.id);
// Three weak structural signals (5 + 10 + 8) that sit well under the thresholds on their own.
const pitchy = {
	html: '<p>See <a href="https://tracker.example.net/x">https://shop.example.org</a> or http://10.0.0.1/deal</p>',
	replyTo: "someone@elsewhere.example",
};

test("authentication passes count half for a first-contact sender", async (t) => {
	const { analyze } = await createFixture(t);
	const result = await analyze("hello@throwaway-seo.example", pitchy);
	const passes = result.signals.filter((signal) => signal.id.endsWith("_passed")).map((signal) => [signal.id, signal.score]).sort();
	assert.deepEqual(passes, [["dkim_passed", -2], ["dmarc_passed", -4]]);
});

test("a recurring sender gets the full pass credit once it has been seen twice with no spam reports", async (t) => {
	const { addReputation, analyze } = await createFixture(t);
	const dmarc = async (from) => (await analyze(from, pitchy)).signals.find((signal) => signal.id === "dmarc_passed")?.score;
	addReputation("email", "once@vendor.example", 0, 0, 1);
	assert.equal(await dmarc("once@vendor.example"), -4, "seen once is still a first contact");
	addReputation("email", "billing@vendor.example", 0, 0, 2);
	assert.equal(await dmarc("billing@vendor.example"), -8);
	addReputation("email", "reported@vendor.example", 1, 0, 2);
	assert.equal(await dmarc("reported@vendor.example"), -4, "a spam report withdraws the credit");
	addReputation("domain", "bigbank.example", 0, 0, 40);
	assert.equal(await dmarc("other@bigbank.example"), -4, "a busy domain does not vouch for a new address");
});

test("a first-contact password reset from a new domain with passing authentication stays below the spam threshold", async (t) => {
	const { analyze } = await createFixture(t);
	const intelligenceProvider = { check: async () => [
		{ id: "new_sender_domain", score: 25, reason: "young" },
		{ id: "new_link_domain", score: 10, reason: "young link" },
	] };
	const overrides = {
		subject: "Reset your password",
		text: "Urgent: confirm your account password within 24 hours.",
		html: '<p>Urgent: confirm your account password within 24 hours. <a href="https://link.example.net/r">https://app.example.org/reset</a></p>',
	};
	const first = await analyze("no-reply@fresh-app.example", overrides, PASS, intelligenceProvider);
	// 25 + 10 + 24 (credential_phishing_pattern) + 10 (displayed_link_mismatch) = 69, minus half the pass credit (7).
	assert.equal(first.score, 62, ids(first).join());
	assert.equal(first.verdict, "suspicious");
	const failing = await analyze("no-reply@fresh-app.example", overrides, { spf: "pass", dkim: "pass", dmarc: "fail" }, intelligenceProvider);
	assert.equal(failing.verdict, "spam");
});

test("authentication passes still count for a sender the user has written to or saved", async (t) => {
	const { addContact, analyze } = await createFixture(t);
	addContact("friend@known.example", "outbound");
	const result = await analyze("friend@known.example", pitchy);
	assert.ok(ids(result).includes("dmarc_passed"), ids(result).join());
	assert.ok(ids(result).includes("previously_sent"));
});

test("authentication passes still count for a sender with a good reputation in the mailbox", async (t) => {
	const { addReputation, analyze } = await createFixture(t);
	addReputation("domain", "newsletter.example", 0, 6);
	const result = await analyze("news@newsletter.example", pitchy);
	assert.ok(ids(result).includes("dmarc_passed"), ids(result).join());
});

test("authentication failures still add score for a first-contact sender", async (t) => {
	const { analyze } = await createFixture(t);
	const result = await analyze("hello@throwaway-seo.example", {}, { spf: "pass", dkim: "fail", dmarc: "pass" });
	assert.equal(result.signals.find((signal) => signal.id === "dkim_failed").score, 8);
});

test("a first-contact receipt with a brand-new sending domain is filed in the Inbox", async (t) => {
	const { analyze } = await createFixture(t);
	const html = '<p>Receipt <a href="https://track.example.net/r">https://shop.example.org/order</a></p>';
	const intelligenceProvider = { check: async () => [{ id: "domain_under_week", score: 25, reason: "Domain registered under a week ago" }] };
	const result = await analyze("orders@new-shop.example", { html, subject: "Your receipt", text: "Thanks for your order." }, PASS, intelligenceProvider);
	// 10 (link) + 25 (young domain) = 35, minus half the pass credit (7) = 28. Stays in the Inbox.
	assert.equal(result.score, 28);
	assert.equal(result.verdict, "inbox");
});

const seoPitch = {
	subject: "Submit example.org to Search Engines",
	text: "Hello, we can submit example.org to search engines and improve your rankings on Google with quality backlinks.",
};

test("an unsolicited SEO pitch naming the recipient's own domain is flagged on first contact", async (t) => {
	const { analyze } = await createFixture(t);
	const result = await analyze("promo@throwaway-seo.example", { ...seoPitch, toAddr: "kevin@example.org" });
	assert.ok(ids(result).includes("unsolicited_solicitation"), ids(result).join());
	assert.equal(result.signals.find((signal) => signal.id === "unsolicited_solicitation").score, 45);
	const subjectOnly = await analyze("promo@throwaway-seo.example", { subject: "Submit example.org to Search Engines", text: "Our SEO services start today.", toAddr: "kevin@example.org" });
	assert.ok(ids(subjectOnly).includes("unsolicited_solicitation"), ids(subjectOnly).join());
});

test("the solicitation signal needs every condition: no unsubscribe link, a prior relationship or a reply thread each clear it", async (t) => {
	const { addContact, addReputation, analyze } = await createFixture(t);
	const to = { ...seoPitch, toAddr: "kevin@example.org" };
	const flagged = async (from, overrides = {}, headers) => ids(await analyze(from, { ...to, ...overrides }, PASS, undefined, headers)).includes("unsolicited_solicitation");
	assert.equal(await flagged("a@bulk.example", {}, { "List-Unsubscribe": "<mailto:u@bulk.example>" }), false);
	assert.equal(await flagged("a@bulk.example", { inReplyTo: "<abc@example.org>" }), false);
	assert.equal(await flagged("a@bulk.example", { subject: "Hello", text: "We help with search engines and backlinks." }), false, "no recipient domain");
	assert.equal(await flagged("a@bulk.example", { subject: "About example.org", text: "Your site example.org looks great, call me." }), false, "no pitch phrases");
	assert.equal(await flagged("a@bulk.example", { subject: "About example.org", text: "Cheap backlinks." }), false, "one pitch phrase is not enough");
	addContact("known@vendor.example", "inbound");
	assert.equal(await flagged("known@vendor.example"), false, "an existing contact is not a first contact");
	addReputation("email", "a@seen.example", 0, 1);
	assert.equal(await flagged("a@seen.example"), false, "an address seen before is not a first contact");
	addReputation("domain", "gmail.com", 0, 40);
	assert.equal(await flagged("stranger@gmail.com"), true, "mail from a busy shared domain is still a first contact");
	addReputation("domain", "busy.example", 0, 40);
	assert.equal(await flagged("new-person@busy.example"), true, "a new address on a known domain is a first contact");
});

test("the recipient's own address in a footer does not count as naming their domain", async (t) => {
	const { analyze } = await createFixture(t);
	const onboarding = {
		subject: "Welcome to RankBoost",
		text: "Boost your traffic with our SEO audit and quality backlinks, and see where you rank on Google.\n\nThis email was sent to kevin@example.org.",
		toAddr: "kevin@example.org",
	};
	assert.equal(ids(await analyze("hello@rankboost.example", onboarding)).includes("unsolicited_solicitation"), false);
	const named = { ...onboarding, text: `${onboarding.text}\nWe checked example.org for you.` };
	assert.equal(ids(await analyze("hello@rankboost.example", named)).includes("unsolicited_solicitation"), true);
});

test("a transactional message that mentions the recipient's domain is not flagged", async (t) => {
	const { analyze } = await createFixture(t);
	const result = await analyze("noreply@search.example.com", {
		subject: "Search Console: example.org was added", toAddr: "kevin@example.org",
		text: "A new owner was added to example.org in Search Console.",
	});
	assert.equal(ids(result).includes("unsolicited_solicitation"), false);
});

test("strictness moves the spam threshold; normal stays at 70", async (t) => {
	const { analyze } = await createFixture(t);
	const provider = (score) => ({ check: async () => [{ id: "listed", score, reason: "Listed" }] });
	const verdict = async (score, strictness) => (await analyze("a@b.example", {}, {}, provider(score), undefined, strictness)).verdict;
	assert.equal(await verdict(60, undefined), "suspicious");
	assert.equal(await verdict(60, "normal"), "suspicious");
	assert.equal(await verdict(70, "normal"), "spam");
	assert.equal(await verdict(60, "strict"), "spam");
	assert.equal(await verdict(54, "strict"), "suspicious");
	assert.equal(await verdict(75, "relaxed"), "suspicious");
	assert.equal(await verdict(85, "relaxed"), "spam");
});

test("a failed DMARC is still filed as spam at every strictness", async (t) => {
	const { analyze } = await createFixture(t);
	for (const strictness of ["relaxed", "normal", "strict"]) {
		const result = await analyze("a@b.example", {}, { dmarc: "fail" }, undefined, undefined, strictness);
		assert.equal(result.verdict, "spam", strictness);
	}
});
