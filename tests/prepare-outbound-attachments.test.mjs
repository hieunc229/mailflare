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
	"attachment-policy": "export async function getSharedFilesNotice(env) { return env.customNotice ?? null; }",
};
await build({
	entryPoints: [join(root, "src/lib/email/cloud-attachment-utils.ts")],
	outfile: join(outDir, "prepare.mjs"),
	bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
	alias: { "@": join(root, "src") },
	plugins: [{
		name: "stubs",
		setup(b) {
			b.onResolve({ filter: /^\.\/(shared-attachments|attachment-policy)$/ }, (args) => ({ path: args.path.slice(2), namespace: "stub" }));
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
	test(`${provider}: a file past the 25 MB direct limit becomes a Shared Files link, small files stay attached`, async () => {
		const env = makeEnv();
		const small = file("small.pdf", 2 * MB, "att_small");
		const out = await prepareOutboundAttachments(env, provider, [small, file("big.pdf", 30 * MB, "att_big")], message);
		assert.deepEqual(out.attachments, [small]);
		assert.deepEqual(env.linked, ["att_big"]);
		assert.match(out.html, /^<p>Hi<\/p><div>.*big\.pdf \(30\.0 MB\): <a href="https:\/\/mail\.example\.com\/api\/shared-files\/link_att_big">/s);
		assert.match(out.text, /^Hi\n\n.*big\.pdf \(30\.0 MB\): https:\/\/mail\.example\.com\/api\/shared-files\/link_att_big/s);
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

test("the notice follows the sender's locale and the administrator's custom text wins", async () => {
	const localized = await prepareOutboundAttachments(makeEnv(), "resend", [file("big.pdf", 30 * MB, "x")], { ...message, locale: "de" });
	assert.ok(localized.text.includes(de["attachment.sharedIntro"].replace("{days}", "30")));
	assert.ok(localized.html.includes(`>${de["attachment.sharedDownload"]}</a>`));
	const custom = await prepareOutboundAttachments(makeEnv({ customNotice: "Grosse Dateien ({days} Tage):" }), "ses", [file("big.pdf", 30 * MB, "x")], { ...message, locale: "de" });
	assert.ok(custom.text.includes("Grosse Dateien (30 Tage):"));
	assert.ok(!custom.text.includes(de["attachment.sharedIntro"].replace("{days}", "30")));
});
