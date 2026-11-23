import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-prepare-attachments-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

// The database-backed collaborators are replaced; everything else (planner, notice, i18n) is the real code.
const stubs = {
	"shared-attachments": `export const SHARED_ATTACHMENT_LINK_DAYS = 30;
		export async function getOrCreateSharedAttachmentUrl(env, id, origin) { env.linked.push(id); return \`\${origin}/api/shared-files/link_\${id}\`; }`,
};
await build({
	entryPoints: [join(root, "src/lib/email/cloud-attachment-utils.ts")],
	outfile: join(outDir, "prepare.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "stubs",
		setup(b) {
			b.onResolve({ filter: /^\.\/(shared-attachments)$/ }, (args) => ({ path: args.path.slice(2), namespace: "stub" }));
			b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({ contents: stubs[args.path], loader: "js" }));
		},
	}],
});
const { prepareOutboundAttachments } = await import(pathToFileURL(join(outDir, "prepare.mjs")).href);

const de = JSON.parse(readFileSync(join(root, "public/locales/de.json"), "utf8"));
const MB = 1_000_000;
const file = (name, size, storageId) => ({ filename: name, type: "application/pdf", content: new ArrayBuffer(size), ...(storageId ? { storageId } : {}) });
const message = { subject: "Report", html: "<p>Hi</p>", text: "Hi", headers: {}, publicOrigin: "https://mail.example.com" };
const makeEnv = (extra = {}) => ({ linked: [], ASSETS: { fetch: async () => new Response(JSON.stringify(de)) }, ...extra });

for (const provider of ["resend", "ses"]) {
	test(`${provider}: a file past the 20 MB direct limit becomes a Shared Files link, small files stay attached`, async () => {
		const env = makeEnv();
		const small = file("small.pdf", 2 * MB, "att_small");
		const out = await prepareOutboundAttachments(env, provider, [small, file("big.pdf", 30 * MB, "att_big")], message);
		assert.deepEqual(out.attachments, [small]);
		assert.deepEqual(env.linked, ["att_big"]);
		// One card: the whole box is the download anchor, name, type, size and expiry are inside it.
		assert.ok(out.html.startsWith("<p>Hi</p>"));
		assert.match(out.html, /<table role="presentation"/);
		assert.match(out.html, /<a href="https:\/\/mail\.example\.com\/api\/shared-files\/link_att_big"[^>]*>/);
		assert.ok(out.html.includes("big.pdf"));
		assert.ok(out.html.includes("PDF · 30.0 MB"));
		assert.match(out.text, /^Hi\n\n.*Files shared through Mailflare \(download links expire after 30 days\):\n\n.*big\.pdf \(PDF · 30\.0 MB\): https:\/\/mail\.example\.com\/api\/shared-files\/link_att_big/s);
	});

	test(`${provider}: an over-threshold file without a storageId is refused, not dropped`, async () => {
		await assert.rejects(prepareOutboundAttachments(makeEnv(), provider, [file("big.pdf", 30 * MB)], message), /not stored in object storage/);
	});

	test(`${provider}: nothing over the threshold leaves the body untouched and creates no links`, async () => {
		const env = makeEnv();
		const out = await prepareOutboundAttachments(env, provider, [file("a.pdf", 10 * MB, "a")], message);
		assert.equal(out.html, message.html);
		assert.equal(out.text, message.text);
		assert.deepEqual(env.linked, []);
	});
}

test("the notice follows the sender's locale", async () => {
	const localized = await prepareOutboundAttachments(makeEnv(), "resend", [file("big.pdf", 30 * MB, "x")], { ...message, locale: "de" });
	assert.ok(localized.text.includes(de["attachment.sharedIntro"].replace("{days}", "30")));
	assert.ok(localized.html.includes(de["attachment.sharedDownload"]));
	assert.ok(localized.html.includes(de["attachment.sharedIntro"].replace("{days}", "30")));
});

// The administrator's settings reach the message: the notice switch, a custom sentence, the lifetime and the style.
// A D1-shaped binding whose only row answers the app_settings select drizzle emits. drizzle calls
// env.DB.prepare(sql) and then .bind(...params) on the returned statement.
const reflect = (settings) => {
	const row = {
		shared_files_notice_enabled: settings.enabled ?? true,
		shared_files_notice_text: settings.text ?? null,
		shared_files_link_days: settings.days ?? 30,
		shared_files_notice_locale: settings.locale ?? null,
		shared_files_card_style: settings.style ?? "card",
	};
	const statement = {
		all: async () => ({ results: [row], success: true, meta: {} }),
		raw: async () => [Object.values(row)],
		run: async () => ({ results: [], success: true, meta: {} }),
		bind: () => statement,
	};
	return { prepare: () => statement };
};
const broken = () => {
	const statement = {
		all: async () => { throw new Error("no such column"); },
		raw: async () => { throw new Error("no such column"); },
		run: async () => { throw new Error("no such column"); },
		bind: () => statement,
	};
	return { prepare: () => statement };
};

test("the administrator can switch the notice off and the cards still go out", async () => {
	const env = { ...makeEnv(), DB: reflect({ enabled: false }) };
	const out = await prepareOutboundAttachments(env, "resend", [file("big.pdf", 30 * MB, "x")], message);
	assert.match(out.html, /<a href="https:\/\/mail\.example\.com\/api\/shared-files\/link_x"/);
	assert.doesNotMatch(out.text, /Files shared through Mailflare/);
	assert.doesNotMatch(out.html, /Expires in/);
});

test("a custom sentence and a custom lifetime replace the defaults", async () => {
	const env = { ...makeEnv(), DB: reflect({ text: "Te dejo los archivos, caducan en {days} días:", days: 7 }) };
	const out = await prepareOutboundAttachments(env, "resend", [file("big.pdf", 30 * MB, "x")], message);
	assert.ok(out.text.includes("Te dejo los archivos, caducan en 7 días:"));
	assert.ok(out.text.includes("Expires in 7 days") || out.html.includes("Expires in 7 days"));
});

test("the plain-links presentation removes the cards", async () => {
	const env = { ...makeEnv(), DB: reflect({ style: "links" }) };
	const out = await prepareOutboundAttachments(env, "resend", [file("big.pdf", 30 * MB, "x")], message);
	assert.doesNotMatch(out.html, /<table/);
	assert.match(out.html, /<li>big\.pdf \(PDF · 30\.0 MB\): <a href="/);
});

test("an unreadable settings table falls back to the defaults instead of failing the send", async () => {
	const env = { ...makeEnv(), DB: broken() };
	const out = await prepareOutboundAttachments(env, "resend", [file("big.pdf", 30 * MB, "x")], message);
	assert.match(out.html, /Files shared through Mailflare \(download links expire after 30 days\):/);
	assert.match(out.html, /<table role="presentation"/);
});
