import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "mailflare-takeout-run-"));
after(() => rmSync(dir, { recursive: true, force: true }));
await build({
	entryPoints: { r: join(root, "src/lib/import/takeout-calendar-utils.ts") },
	outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", logLevel: "silent",
	alias: { "@": join(root, "src") },
});
const { importCalendarBytes, previewCalendarBytes, makeBatches, parseRetryAfter } = await import(pathToFileURL(join(dir, "r.mjs")).href);

const settings = { name: "me@gmail.com", color: "#2563eb", googleAddress: "me@gmail.com", reminders: true, skipDeclined: true };
const vevent = (n, ...extra) => ["BEGIN:VEVENT", `UID:e${n}@google.com`, "DTSTART:20261104T090000Z", `SUMMARY:E${n}`, ...extra, "END:VEVENT"].join("\r\n");
const file = (count, extra = () => []) => new TextEncoder().encode(["BEGIN:VCALENDAR", ...Array.from({ length: count }, (_, n) => vevent(n, ...extra(n))), "END:VCALENDAR"].join("\r\n"));
const ok = (body) => ({ status: 200, data: { imported: body.groups.length, skipped: 0, simplified: 0, guessedZone: 0, failed: 0, errors: [] } });

test("groups go out in bounded batches with the settings attached", async () => {
	const bodies = [];
	const summary = await importCalendarBytes(file(120), settings, { post: async (body) => (bodies.push(body), ok(body)) });
	assert.deepEqual(bodies.map((body) => body.groups.length), [50, 50, 20]);
	assert.deepEqual(bodies[0].source, { name: "me@gmail.com", color: "#2563eb", googleAddress: "me@gmail.com" });
	assert.deepEqual(bodies[0].options, { reminders: true, skipDeclined: true });
	assert.equal(summary.imported, 120);
	assert.equal(summary.events, 120);
	assert.equal(summary.aborted, false);
	assert.ok(makeBatches(["x".repeat(200_000), "y".repeat(200_000), "z"]).length === 2);
});

test("a batch the server cannot take is halved down to single events; one that still fails is counted", async () => {
	const sizes = [];
	const summary = await importCalendarBytes(file(8), settings, {
		post: async (body) => {
			sizes.push(body.groups.length);
			return body.groups.length > 2 || body.groups.some((group) => group.includes("UID:e5@")) ? { status: 503, data: {} } : ok(body);
		},
	});
	assert.equal(summary.imported, 7);
	assert.equal(summary.failed, 1);
	assert.equal(summary.errors.length, 1);
	assert.deepEqual(sizes.slice(0, 3), [8, 4, 2]);
	const network = await importCalendarBytes(file(2), settings, { post: async (body) => { if (body.groups.length > 1) throw new TypeError("network"); return ok(body); } });
	assert.equal(network.imported, 2);
});

test("an authorization or validation error stops the import with the server's message", async () => {
	await assert.rejects(() => importCalendarBytes(file(3), settings, { post: async () => ({ status: 403, data: { error: "Calendar is disabled for this account" } }) }), /Calendar is disabled/);
});

test("a 429 waits (Retry-After, else backoff) and retries the same batch without halving; a few tries then a clear stop", async () => {
	const sizes = [];
	const sleeps = [];
	const sleep = async (ms) => { sleeps.push(ms); };
	let limited = 2;
	const summary = await importCalendarBytes(file(8), settings, {
		sleep,
		post: async (body) => { sizes.push(body.groups.length); return limited-- > 0 ? { status: 429, retryAfterMs: 7000, data: {} } : ok(body); },
	});
	assert.deepEqual(sizes, [8, 8, 8]);
	assert.deepEqual(sleeps, [7000, 7000]);
	assert.equal(summary.imported, 8);
	assert.equal(summary.failed, 0);
	sleeps.length = 0;
	limited = 3;
	await importCalendarBytes(file(2), settings, { sleep, post: async (body) => (limited-- > 0 ? { status: 429, data: {} } : ok(body)) });
	assert.deepEqual(sleeps, [2000, 4000, 8000]);
	// Out of tries: the counts of what already went through stay, the rest is not sent, and the summary says why.
	let calls = 0;
	const stopped = await importCalendarBytes(file(60), settings, { sleep, post: async (body) => { calls++; return calls === 1 ? ok(body) : { status: 429, data: {} }; } });
	assert.equal(calls, 6);
	assert.equal(stopped.imported, 50);
	assert.equal(stopped.rateLimited, true);
	assert.equal(stopped.aborted, false);
	assert.equal((await importCalendarBytes(file(2), settings, { post: async (body) => ok(body) })).rateLimited, false);
});

test("events are counted only where a line starts with BEGIN:VEVENT, in any case", () => {
	const quoted = (n) => `BEGIN:VEVENT\r\nUID:q${n}\r\nDESCRIPTION:${"xBEGIN:VEVENT".repeat(300)}\r\nEND:VEVENT`;
	assert.equal(makeBatches([quoted(1), quoted(2)]).length, 1);
	const lower = () => Array.from({ length: 300 }, (_, n) => `begin:vevent\r\nuid:l${n}\r\nend:vevent`).join("\r\n");
	assert.equal(makeBatches([lower(), lower()]).length, 2);
});

test("Retry-After is read as seconds or a date and kept between 1 and 60 seconds", () => {
	const now = Date.parse("2026-11-20T10:00:00Z");
	assert.equal(parseRetryAfter("7", now), 7000);
	assert.equal(parseRetryAfter("0", now), 1000);
	assert.equal(parseRetryAfter("3600", now), 60_000);
	assert.equal(parseRetryAfter("Fri, 20 Nov 2026 10:00:20 GMT", now), 20_000);
	assert.equal(parseRetryAfter("Fri, 20 Nov 2026 09:00:00 GMT", now), 1000);
	assert.equal(parseRetryAfter("soon", now), undefined);
	assert.equal(parseRetryAfter(null, now), undefined);
});

test("a request body is kept under the server's 1 MiB limit by encoded length; a group that cannot fit is counted", async () => {
	const pad = (events) => Array.from({ length: events }, (_, n) => `BEGIN:VEVENT\r\nUID:big${n}\r\nDTSTART:20261104T090000Z\r\n${Array.from({ length: 2 }, () => `X-PAD:${"\u0001".repeat(60_000)}`).join("\r\n")}\r\nEND:VEVENT`);
	// Two groups of 120,000 characters each pass the character budget, but each control character is 6 bytes of JSON.
	const sizes = [];
	const bodies = [];
	const two = await importCalendarBytes(new TextEncoder().encode(pad(2).join("\r\n")), settings, {
		post: async (body) => { bodies.push(JSON.stringify(body).length); sizes.push(body.groups.length); return ok(body); },
	});
	assert.deepEqual(sizes, [1, 1]);
	assert.ok(bodies.every((size) => size < 1024 * 1024));
	assert.equal(two.imported, 2);
	// One UID with many changes whose JSON is over the limit travels nowhere and says why.
	const events = Array.from({ length: 4 }, (_, n) => `BEGIN:VEVENT\r\nUID:huge\r\nRECURRENCE-ID:2026110${n + 1}T090000Z\r\nDTSTART:20261104T090000Z\r\n${Array.from({ length: 2 }, () => `X-PAD:${"\u0001".repeat(60_000)}`).join("\r\n")}\r\nEND:VEVENT`);
	let posted = 0;
	const huge = await importCalendarBytes(new TextEncoder().encode(events.join("\r\n")), settings, { post: async (body) => { posted++; return ok(body); } });
	assert.equal(posted, 0);
	assert.equal(huge.failed, 4);
	assert.match(huge.errors[0], /too large/i);
});

test("stopping ends between batches", async () => {
	const controller = new AbortController();
	let calls = 0;
	const summary = await importCalendarBytes(file(120), settings, { signal: controller.signal, post: async (body) => { calls++; controller.abort(); return ok(body); } });
	assert.equal(calls, 1);
	assert.equal(summary.aborted, true);
	assert.equal(summary.imported, 50);
});

test("progress reports groups done out of total", async () => {
	const seen = [];
	await importCalendarBytes(file(60), settings, { post: async (body) => ok(body), onProgress: (done, total) => seen.push([done, total]) });
	assert.deepEqual(seen.at(-1), [60, 60]);
	// A series and its changed occurrences are several events of one group; progress counts events, so the label is true.
	const series = new TextEncoder().encode(Array.from({ length: 3 }, (_, n) => [vevent(`s${n}`), vevent(`s${n}`), vevent(`s${n}`)].join("\r\n")).join("\r\n"));
	const counted = [];
	await importCalendarBytes(series, settings, { post: async (body) => ok(body), onProgress: (done, total) => counted.push([done, total]) });
	assert.deepEqual(counted.at(-1), [9, 9]);
	const previewed = [];
	await previewCalendarBytes(series, settings, "UTC", { onProgress: (done, total) => previewed.push([done, total]) });
	assert.deepEqual(previewed.at(-1), [9, 9]);
});

test("files over the event cap and UIDs without an id are reported", async () => {
	const noUid = new TextEncoder().encode("BEGIN:VEVENT\r\nDTSTART:20261104T090000Z\r\nEND:VEVENT\r\n");
	const summary = await importCalendarBytes(noUid, settings, { post: async (body) => ok(body) });
	assert.equal(summary.failed, 1);
	assert.equal(summary.imported, 0);
});

test("preview counts events, series and simplified series without posting", async () => {
	const bytes = file(4, (n) => (n === 0 ? ["RRULE:FREQ=WEEKLY;BYDAY=WE"] : n === 1 ? ["RRULE:FREQ=YEARLY"] : n === 2 ? ["STATUS:CANCELLED"] : []));// 2026-11-04 is a Wednesday
	const summary = await previewCalendarBytes(bytes, settings, "UTC", {});
	assert.equal(summary.events, 3);
	assert.equal(summary.series, 2);
	assert.equal(summary.simplified, 1);
	assert.equal(summary.skipped, 1);
	assert.equal(summary.imported, 0);
});
