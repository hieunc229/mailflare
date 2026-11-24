import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-mailbox-owner-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	stdin: {
		contents: `
			export { fetchMailboxOptions, clearMailboxesCache } from "./src/components/mailbox-provider-utils.ts";
			export { isAddressBookOwner } from "./src/components/settings/takeout-contacts-card-utils.ts";
		`,
		resolveDir: root,
		sourcefile: "mailbox-owner-entry.ts",
	},
	outfile: join(dir, "entry.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@/lib/auth/client": join(dir, "auth-client.mjs"), "@": join(root, "src") },
	plugins: [{ name: "stub", setup: (b) => b.onResolve({ filter: /^@\/lib\/auth\/client$/ }, () => ({ path: "stub:auth", namespace: "stub" })) },
		{ name: "stub-load", setup: (b) => b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: `export const getClientSessionToken = () => "t"; export const authFetch = (...args) => globalThis.__mailboxTestFetch(...args);`, loader: "js" })) }],
});
const { fetchMailboxOptions, clearMailboxesCache, isAddressBookOwner } = await import(pathToFileURL(join(dir, "entry.mjs")).href);

const listing = (mailboxes) => { globalThis.__mailboxTestFetch = async () => ({ json: async () => ({ mailboxes }) }); clearMailboxesCache(); };
const row = (id, userId, extra = {}) => ({ id, userId, domainId: "d", localPart: id, hostname: "x.test", type: "personal", permission: "full_access", ...extra });

test("the mailbox options keep who owns each mailbox", async () => {
	listing([row("mine", "u1"), row("shared", "u2", { type: "shared", permission: "send_as" })]);
	const options = await fetchMailboxOptions(true);
	assert.deepEqual(options.map((option) => option.userId), ["u1", "u2"]);
});

test("a delegate of a shared mailbox is not the address book owner, the owner is", async () => {
	listing([row("mine", "u1"), row("shared", "u2", { type: "shared" })]);
	const [mine, shared] = await fetchMailboxOptions(true);
	assert.equal(isAddressBookOwner(shared, "u1"), false);
	assert.equal(isAddressBookOwner(mine, "u1"), true);
});
