/**
 * Short check of calendar and contacts sync (CalDAV and CardDAV) against a
 * running Mailflare: discovery, listing the calendar and address book
 * collections, then create, read and delete one test event and one test
 * contact. It deletes what it creates.
 *
 *   DAV_URL=https://mail.example.com DAV_PASSWORD=<app password> node scripts/dav-smoke.mjs
 *
 * DAV_PASSWORD is an app password with "Calendar and contacts" ticked (Settings >
 * App passwords). DAV_URL defaults to http://localhost:3000; plain HTTP is accepted
 * only for localhost and 127.0.0.1, other addresses must be https://. Sync must be switched on under Admin > General.
 */

const BASE = (process.env.DAV_URL ?? "http://localhost:3000").replace(/\/$/, "");
const { protocol, hostname } = new URL(BASE);
if (protocol === "http:" && !["localhost", "127.0.0.1"].includes(hostname)) {
	console.error("Refusing to send an app password over plain HTTP to another machine. Use an https:// DAV_URL.");
	process.exit(2);
}
const PASSWORD = process.env.DAV_PASSWORD;
if (!PASSWORD) {
	console.error("Set DAV_PASSWORD to an app password with Calendar and contacts access.");
	process.exit(2);
}
const AUTH = `Basic ${Buffer.from(`mailflare:${PASSWORD.replace(/[\s-]/g, "")}`).toString("base64")}`;

let failed = 0;
function check(name, ok, detail) {
	if (!ok) failed += 1;
	console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` (${detail})`}`);
}

function dav(method, path, { body, headers = {}, auth = true } = {}) {
	return fetch(`${BASE}${path}`, { method, redirect: "manual", body, headers: { ...(auth ? { Authorization: AUTH } : {}), ...headers } });
}

const PROPFIND_HEADERS = { Depth: "0", "Content-Type": "application/xml; charset=utf-8" };
const hrefIn = (xml, name) => xml.match(new RegExp(`<[^>]*${name}[^>]*>\\s*<[^>]*href[^>]*>([^<]+)<`))?.[1];

console.log("Discovery");
const options = await dav("OPTIONS", "/dav/", { auth: false });
check("OPTIONS /dav/ advertises calendar and address book support", /calendar-access/.test(options.headers.get("dav") ?? "") && /addressbook/.test(options.headers.get("dav") ?? ""), `${options.status} ${options.headers.get("dav")}`);
const anonymous = await dav("PROPFIND", "/dav/", { auth: false, headers: PROPFIND_HEADERS });
check("PROPFIND without a password is refused", anonymous.status === 401, anonymous.status);
for (const name of ["caldav", "carddav"]) {
	const wellKnown = await dav("GET", `/.well-known/${name}`, { auth: false });
	check(`/.well-known/${name} leads to /dav/`, wellKnown.status === 301 && (wellKnown.headers.get("location") ?? "").endsWith("/dav/"), wellKnown.status);
}
const root = await dav("PROPFIND", "/dav/", { headers: PROPFIND_HEADERS, body: '<propfind xmlns="DAV:"><prop><current-user-principal/></prop></propfind>' });
const rootXml = await root.text();
const principal = hrefIn(rootXml, "current-user-principal");
check("the root names the signed-in principal", root.status === 207 && !!principal, `${root.status}${root.status === 401 ? " - wrong password, or sync is off for it" : ""}`);
if (!principal) process.exit(1);
const home = await (await dav("PROPFIND", principal, { headers: PROPFIND_HEADERS, body: '<propfind xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav"><prop><C:calendar-home-set/><CR:addressbook-home-set/></prop></propfind>' })).text();
const calendarHome = hrefIn(home, "calendar-home-set");
const bookHome = hrefIn(home, "addressbook-home-set");
check("the principal lists a calendar home and an address book home", !!calendarHome && !!bookHome, home.slice(0, 200));
if (!calendarHome || !bookHome) process.exit(1);
for (const [label, home] of [["calendar", calendarHome], ["address book", bookHome]]) {
	const listing = await dav("PROPFIND", home, { headers: { ...PROPFIND_HEADERS, Depth: "1" }, body: '<propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>' });
	const listingXml = await listing.text();
	check(`the ${label} home lists its default collection`, listing.status === 207 && /\/default\/?</.test(listingXml), listing.status);
}

async function roundTrip(label, folder, name, type, body, mustContain) {
	console.log(`\n${label}`);
	const path = `${folder}default/${name}`;
	const put = await dav("PUT", path, { headers: { "Content-Type": type, "If-None-Match": "*" }, body });
	check("PUT creates it", put.status === 201, put.status);
	const etag = put.headers.get("etag");
	check("PUT returns an ETag", !!etag);
	const got = await dav("GET", path);
	check("GET returns what was written", got.status === 200 && (await got.text()).includes(mustContain), got.status);
	const stale = await dav("PUT", path, { headers: { "Content-Type": type, "If-Match": '"0"' }, body });
	check("a stale If-Match is refused", stale.status === 412, stale.status);
	const gone = await dav("DELETE", path);
	check("DELETE removes it", gone.status === 204, gone.status);
	check("it is gone afterwards", (await dav("GET", path)).status === 404);
}

const stamp = Date.now();
const event = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Mailflare//dav-smoke//EN", "BEGIN:VEVENT", `UID:dav-smoke-${stamp}@mailflare`, "DTSTAMP:20260101T000000Z", "DTSTART:20300101T100000Z", "DTEND:20300101T110000Z", "SUMMARY:Mailflare sync check", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const card = ["BEGIN:VCARD", "VERSION:3.0", `UID:dav-smoke-${stamp}`, "FN:Mailflare Sync Check", "N:Check;Mailflare Sync;;;", `EMAIL:sync-check-${stamp}@example.invalid`, "END:VCARD", ""].join("\r\n");
await roundTrip("Calendar", calendarHome, `dav-smoke-${stamp}.ics`, "text/calendar; charset=utf-8", event, "Mailflare sync check");
await roundTrip("Contacts", bookHome, `dav-smoke-${stamp}.vcf`, "text/vcard; charset=utf-8", card, "Mailflare Sync Check");

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
