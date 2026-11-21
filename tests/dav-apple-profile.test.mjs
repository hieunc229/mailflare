import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadFixture } from "./helpers/fixtures.mjs";

const fixture = await loadFixture({ name: "dav-apple-profile", entryPoint: "src/lib/dav/apple-profile-utils.ts", mocks: {} });
const { buildAppleProfile, APPLE_PROFILE_FILE_NAME } = await fixture.import();
after(() => fixture.dispose());

let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const input = { origin: "https://mail.example.com", userId: "u1", username: "me@example.com", password: "abcdefghijklmnop", uuid };

test("the profile sets up a calendar and an address book account on the server", () => {
	const xml = buildAppleProfile(input);
	assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
	for (const type of ["com.apple.caldav.account", "com.apple.carddav.account", "Configuration"]) assert.ok(xml.includes(`<string>${type}</string>`), type);
	for (const prefix of ["CalDAV", "CardDAV"]) {
		assert.ok(xml.includes(`<key>${prefix}HostName</key>\n\t\t\t<string>mail.example.com</string>`), prefix);
		assert.ok(xml.includes(`<key>${prefix}Port</key>\n\t\t\t<integer>443</integer>`), prefix);
		assert.ok(xml.includes(`<key>${prefix}UseSSL</key>\n\t\t\t<true/>`), prefix);
		assert.ok(xml.includes(`<key>${prefix}Username</key>\n\t\t\t<string>me@example.com</string>`), prefix);
		assert.ok(xml.includes(`<key>${prefix}Password</key>\n\t\t\t<string>abcdefghijklmnop</string>`), prefix);
		assert.ok(xml.includes(`<key>${prefix}PrincipalURL</key>\n\t\t\t<string>https://mail.example.com/dav/principals/u1/</string>`), prefix);
	}
	assert.ok(buildAppleProfile({ ...input, origin: "https://mail.example.com:8443" }).includes("<string>https://mail.example.com:8443/dav/principals/u1/</string>"));
});

test("every payload has its own identifier and UUID", () => {
	const xml = buildAppleProfile(input);
	const uuids = [...xml.matchAll(/<key>PayloadUUID<\/key>\n\s*<string>([^<]+)<\/string>/g)].map((match) => match[1]);
	assert.equal(uuids.length, 3);
	assert.equal(new Set(uuids).size, 3);
	const ids = [...xml.matchAll(/<key>PayloadIdentifier<\/key>\n\s*<string>([^<]+)<\/string>/g)].map((match) => match[1]);
	assert.equal(new Set(ids).size, 3);
	assert.ok(ids.every((id) => id.startsWith("com.mailflare.dav.mail.example.com.") || id.startsWith("com.mailflare.dav.caldav.mail.example.com.") || id.startsWith("com.mailflare.dav.carddav.mail.example.com.")));
	assert.ok(ids.includes("com.mailflare.dav.mail.example.com.u1"));
	// Two servers for one user id never replace each other's profile.
	assert.ok(!buildAppleProfile({ ...input, origin: "https://other.example.org" }).includes("mail.example.com"));
});

test("without the calendar only the contacts account is in the profile", () => {
	const xml = buildAppleProfile({ ...input, calendar: false });
	assert.ok(!xml.includes("caldav") && !xml.includes("CalDAV"));
	assert.ok(xml.includes("com.apple.carddav.account"));
	assert.equal([...xml.matchAll(/<key>PayloadUUID<\/key>/g)].length, 2);
});

test("text is escaped so a password or address cannot add keys to the profile", () => {
	const xml = buildAppleProfile({ ...input, username: "a&b<c>@x.test", password: `</string><key>Evil</key>"'&` });
	assert.ok(!xml.includes("<key>Evil</key>"));
	assert.ok(xml.includes("a&amp;b&lt;c&gt;@x.test"));
	assert.ok(xml.includes("&lt;/string&gt;&lt;key&gt;Evil&lt;/key&gt;&quot;&apos;&amp;"));
});

test("a server on another port is named, and a plain-HTTP origin is refused", () => {
	assert.ok(buildAppleProfile({ ...input, origin: "https://mail.example.com:8443" }).includes("<integer>8443</integer>"));
	assert.throws(() => buildAppleProfile({ ...input, origin: "http://mail.example.com" }), /https/i);
	assert.equal(APPLE_PROFILE_FILE_NAME, "mailflare-calendar-contacts.mobileconfig");
});
