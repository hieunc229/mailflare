#!/usr/bin/env node
/**
 * Checks a running Vercel deployment from outside.
 *
 *   node scripts/vercel-smoke.mjs https://mail.example.com
 *
 * Always: the app answers, the internal routes refuse strangers, DAV methods reach the server.
 * With CRON_SECRET: the frequent cron jobs run.
 * With INBOUND_WEBHOOK_SECRET and SMOKE_TO (an existing mailbox): sends a small and a 5 MB message through the
 * relay endpoints, so a large upload goes through object storage.
 * With SMOKE_API_KEY (read scope) as well: waits for both to be delivered, which proves the queue round-trip.
 */
import { createHmac, randomUUID } from "node:crypto";

const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) {
	console.error("Usage: node scripts/vercel-smoke.mjs <base-url>");
	process.exit(2);
}
const { CRON_SECRET, INBOUND_WEBHOOK_SECRET, SMOKE_TO, SMOKE_API_KEY } = process.env;
let failures = 0;

async function check(name, run) {
	try {
		const detail = await run();
		console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL  ${name}: ${error instanceof Error ? error.message : error}`);
	}
}

function expect(response, ...statuses) {
	if (!statuses.includes(response.status)) throw new Error(`expected ${statuses.join(" or ")}, got ${response.status}`);
	return response;
}

await check("app answers", async () => void expect(await fetch(`${base}/api/setup/status`), 200));
await check("cron refuses strangers", async () => void expect(await fetch(`${base}/api/internal/cron/frequent`), 401));
// 401 with QStash; 404 when Vercel Queues is the queue.
await check("queue refuses unsigned messages", async () => void expect(await fetch(`${base}/api/internal/queue/inbound`, { method: "POST", body: "{}" }), 401, 404));
// vercel.json's trigger makes this function private. A 2xx would mean strangers can feed the queue consumer.
await check("queue consumer is not public", async () => {
	const response = await fetch(`${base}/api/queues`, { method: "POST", body: "{}" });
	if (response.ok) throw new Error(`expected a refusal, got ${response.status}`);
	return `${response.status}`;
});
await check("uploads need a session", async () => void expect(await fetch(`${base}/api/uploads`, { method: "POST", body: "{}" }), 401));
for (const path of ["/dav/", "/.well-known/caldav"]) {
	// 401 means the DAV handler saw it; 404 means it is switched off in Admin settings. 405 means the method never arrived.
	await check(`PROPFIND ${path}`, async () => `${expect(await fetch(`${base}${path}`, { method: "PROPFIND", headers: { Depth: "0" }, redirect: "manual" }), 401, 404).status}`);
}

if (CRON_SECRET) {
	await check("frequent cron jobs run", async () => {
		const response = await fetch(`${base}/api/internal/cron/frequent`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } });
		const body = await response.json().catch(() => ({}));
		if (response.status !== 200) throw new Error(`${response.status}, failed: ${body.failed?.join(", ")}`);
		return `${body.ran} jobs`;
	});
} else console.log("skip  cron jobs (set CRON_SECRET)");

const sign = (...parts) => {
	const mac = createHmac("sha256", INBOUND_WEBHOOK_SECRET);
	for (const part of parts) mac.update(part);
	return mac.digest("hex");
};

async function relay(subject, padding) {
	const from = "smoke@example.com";
	const filler = padding ? `${"x".repeat(76)}\r\n`.repeat(Math.ceil(padding / 78)) : "";
	const raw = Buffer.from(`From: ${from}\r\nTo: ${SMOKE_TO}\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@example.com>\r\nDate: ${new Date().toUTCString()}\r\nContent-Type: text/plain\r\n\r\nSmoke test.\r\n${filler}`);
	let uploadKey;
	if (raw.length > 4_000_000) {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const ticket = await (await fetch(`${base}/api/inbound/upload`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Mailflare-Timestamp": timestamp, "X-Mailflare-Signature": sign(`upload\n${timestamp}\n${raw.length}`) },
			body: JSON.stringify({ size: raw.length }),
		})).json();
		if (!ticket.url) throw new Error(`no upload ticket: ${ticket.error}`);
		const put = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: raw });
		if (!put.ok) throw new Error(`storage answered ${put.status}: ${(await put.text()).slice(0, 200)}`);
		uploadKey = ticket.key;
	}
	const timestamp = String(Math.floor(Date.now() / 1000));
	const response = await fetch(`${base}/api/inbound`, {
		method: "POST",
		headers: {
			"Content-Type": "message/rfc822",
			"X-Mailflare-From": from,
			"X-Mailflare-To": SMOKE_TO,
			"X-Mailflare-Headers": "{}",
			"X-Mailflare-Timestamp": timestamp,
			"X-Mailflare-Signature": sign(`v2\n${timestamp}\n${from}\n${SMOKE_TO}\n{}\n`, raw),
			...(uploadKey ? { "X-Mailflare-Upload": uploadKey } : {}),
		},
		body: uploadKey ? undefined : raw,
	});
	const body = await response.json().catch(() => ({}));
	if (response.status !== 200 || body.action === "reject") throw new Error(`${response.status} ${JSON.stringify(body)}`);
	return `${(raw.length / 1e6).toFixed(1)} MB, ${body.action}`;
}

if (INBOUND_WEBHOOK_SECRET && SMOKE_TO) {
	const run = Date.now().toString(36);
	const subjects = [`smoke-small-${run}`, `smoke-large-${run}`];
	await check("small inbound message", () => relay(subjects[0], 0));
	await check("large inbound message through storage", () => relay(subjects[1], 5_000_000));
	if (SMOKE_API_KEY) {
		await check("queue delivers both messages", async () => {
			const started = Date.now();
			let missing = subjects;
			while (missing.length && Date.now() - started < 90_000) {
				const response = expect(await fetch(`${base}/api/v1/messages?direction=inbound&limit=50`, { headers: { Authorization: `Bearer ${SMOKE_API_KEY}` } }), 200);
				const found = new Set((await response.json()).messages.map((message) => message.subject));
				missing = subjects.filter((subject) => !found.has(subject));
				if (missing.length) await new Promise((done) => setTimeout(done, 3000));
			}
			if (missing.length) throw new Error(`not delivered after 90 s: ${missing.join(", ")}`);
			return `${Math.round((Date.now() - started) / 1000)} s`;
		});
	} else console.log("skip  queue round-trip (set SMOKE_API_KEY)");
} else console.log("skip  inbound mail (set INBOUND_WEBHOOK_SECRET and SMOKE_TO)");

console.log(failures ? `${failures} check(s) failed` : "All checks passed");
process.exit(failures ? 1 : 0);
