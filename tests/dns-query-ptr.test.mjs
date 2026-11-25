import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-dns-ptr-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

await build({ entryPoints: { dns: join(root, "src/lib/dns-query.ts") }, outdir: outDir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22", tsconfig: join(root, "tsconfig.json"), logLevel: "silent" });
const { reverseName, queryDns } = await import(pathToFileURL(join(outDir, "dns.mjs")).href);

test("reverseName builds in-addr.arpa names for IPv4", () => {
	assert.equal(reverseName("203.0.113.7"), "7.113.0.203.in-addr.arpa");
});

test("reverseName builds nibble names for IPv6, expanding :: and embedded IPv4", () => {
	assert.equal(reverseName("2001:db8::1"), "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa");
	assert.equal(reverseName("::ffff:192.0.2.1"), "1.0.2.0.0.0.0.c.f.f.f.f.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.ip6.arpa");
	assert.equal(reverseName("2001:DB8:0:0:0:0:0:1"), reverseName("2001:db8::1"));
});

test("reverseName rejects anything that is not an IP literal", () => {
	for (const bad of ["", "example.com", "1.2.3", "1.2.3.256", "01.2.3.4", "1.2.3.4.5", "2001:db8:::1", "2001:db8::1::2", "12345::1", "1:2:3:4:5:6:7:8:9", "::g", "1.2.3.4/24", "1.2.3.4\n", "a.b.c.d"]) assert.equal(reverseName(bad), null, bad);
});

test("PTR is a supported query type with DNS type code 12", async (t) => {
	let requested = "";
	t.mock.method(globalThis, "fetch", async (url) => {
		requested = String(url);
		return Response.json({ Status: 0, Answer: [{ name: "x", type: 12, TTL: 1, data: "mail.example.net." }, { name: "x", type: 5, TTL: 1, data: "ignored." }] });
	});
	assert.deepEqual(await queryDns("7.113.0.203.in-addr.arpa", "PTR"), ["mail.example.net."]);
	assert.match(requested, /type=PTR/);
});
