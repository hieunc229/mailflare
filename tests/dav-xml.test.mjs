import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const parserFixture = await loadFixture({ name: "dav-xml", entryPoint: "src/lib/dav/xml.ts", mocks: {} });
const writerFixture = await loadFixture({ name: "dav-xml-writer", entryPoint: "src/lib/dav/xml-writer.ts", mocks: {} });
after(() => {
	parserFixture.dispose();
	writerFixture.dispose();
});
const { parseDavXml, DavXmlError } = await parserFixture.import();
const { escapeXml, multistatus } = await writerFixture.import();

const DAV = "DAV:";

test("matches by namespace, not by prefix", () => {
	const root = parseDavXml(`<?xml version="1.0" encoding="UTF-8"?><A:propfind xmlns:A="DAV:" xmlns:Z="urn:x"><A:prop><A:displayname/><Z:thing/></A:prop></A:propfind>`);
	assert.equal(root.ns, DAV);
	assert.equal(root.name, "propfind");
	const props = root.children[0].children;
	assert.deepEqual(props.map((p) => [p.ns, p.name]), [[DAV, "displayname"], ["urn:x", "thing"]]);
});

test("default namespace and text content", () => {
	const root = parseDavXml(`<propfind xmlns="DAV:"><prop><displayname>a &amp; b</displayname></prop></propfind>`);
	assert.equal(root.children[0].children[0].text, "a & b");
});

test("DOCTYPE is refused outright", () => {
	assert.throws(() => parseDavXml(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><propfind xmlns="DAV:">&xxe;</propfind>`), DavXmlError);
	assert.throws(() => parseDavXml(`<!DOCTYPE propfind><propfind xmlns="DAV:"/>`), DavXmlError);
});

test("entity expansion bomb is refused", () => {
	const bomb = `<!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><propfind xmlns="DAV:">&b;</propfind>`;
	assert.throws(() => parseDavXml(bomb), DavXmlError);
});

test("undefined entities are parse errors", () => {
	assert.throws(() => parseDavXml(`<propfind xmlns="DAV:">&nope;</propfind>`), DavXmlError);
});

test("processing instructions other than the declaration are refused", () => {
	assert.throws(() => parseDavXml(`<?xml-stylesheet href="x"?><propfind xmlns="DAV:"/>`), DavXmlError);
	assert.throws(() => parseDavXml(`<propfind xmlns="DAV:"><?php x?></propfind>`), DavXmlError);
});

test("depth, element count and text size are capped", () => {
	const deep = "<a xmlns=\"DAV:\">" + "<a>".repeat(40) + "</a>".repeat(40) + "</a>";
	assert.throws(() => parseDavXml(deep), DavXmlError);
	const wide = `<a xmlns="DAV:">` + "<b/>".repeat(20_001) + "</a>";
	assert.throws(() => parseDavXml(wide), DavXmlError);
	assert.throws(() => parseDavXml(`<a xmlns="DAV:">${"x".repeat(64 * 1024 + 1)}</a>`), DavXmlError);
	assert.ok(parseDavXml(`<a xmlns="DAV:">${"x".repeat(1000)}</a>`));
});

test("malformed or empty input throws DavXmlError, never anything else", () => {
	for (const bad of ["", "   ", "<a>", "<a></b>", "not xml", "<a xmlns:x='DAV:'><x:b></a>", "<p:a/>"]) assert.throws(() => parseDavXml(bad), DavXmlError, bad);
});

test("writer escapes text and attribute values", () => {
	assert.equal(escapeXml(`a<b>&"c'`), "a&lt;b&gt;&amp;&quot;c&apos;");
	assert.equal(escapeXml("a\u0000b\u000bc"), "abc");
});

test("multistatus builds a declared, escaped document", () => {
	const xml = multistatus([{ href: "/dav/a&b/", propstats: [{ status: 200, props: ["<D:displayname>x</D:displayname>"] }, { status: 404, props: ["<D:foo/>"] }] }]);
	assert.match(xml, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http:\/\/calendarserver\.org\/ns\/">/);
	assert.match(xml, /<D:href>\/dav\/a&amp;b\/<\/D:href>/);
	assert.match(xml, /<D:status>HTTP\/1\.1 200 OK<\/D:status>/);
	assert.match(xml, /<D:status>HTTP\/1\.1 404 Not Found<\/D:status>/);
	// The writer's own output must be accepted by the parser.
	assert.equal(parseDavXml(xml).name, "multistatus");
});
