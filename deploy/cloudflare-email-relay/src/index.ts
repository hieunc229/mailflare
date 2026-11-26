/**
 * Mailflare email relay. Keeps MX on Cloudflare Email Routing while the app
 * runs elsewhere: every message routed to this Worker is posted to the
 * self-hosted server, which answers with the routing decision so reject and
 * forward still happen here, on the live message.
 *
 * Route the domain's catch-all (and any address rules) to this Worker.
 */
type Env = { MAILFLARE_URL: string; INBOUND_WEBHOOK_SECRET: string };

type Decision =
	| { action: "reject"; reason: string }
	| { action: "forward" | "store"; forwardTo: string | null; forwardToAll?: string[]; forwardHeaders?: Record<string, string> };

/** HMAC-SHA256 over `v2\ntimestamp\nfrom\nto\nheaders\n` + raw body; matches src/lib/email/intake-signature.ts. */
async function sign(secret: string, raw: ArrayBuffer, from: string, to: string, headers: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`v2\n${timestamp}\n${from}\n${to}\n${headers}\n`);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Above this a Vercel-hosted server cannot take the message in the request body (its limit is 4.5 MB). */
const STORAGE_THRESHOLD_BYTES = 4_000_000;

/**
 * Puts a large message in the server's object storage and returns its key. Null when the server takes it
 * directly: self-hosted servers have no upload endpoint and answer 404.
 */
async function uploadToStorage(base: string, secret: string, raw: ArrayBuffer): Promise<string | null> {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`upload\n${timestamp}\n${raw.byteLength}`))), (byte) => byte.toString(16).padStart(2, "0")).join("");
	const response = await fetch(`${base}/api/inbound/upload`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Mailflare-Timestamp": timestamp, "X-Mailflare-Signature": signature },
		body: JSON.stringify({ size: raw.byteLength }),
	});
	if (response.status === 404 || response.status === 405) return null;
	if (!response.ok) throw new Error(`Mailflare answered ${response.status} to the upload request`);
	const ticket = (await response.json()) as { key: string; url: string; headers?: Record<string, string> };
	const put = await fetch(ticket.url, { method: "PUT", headers: ticket.headers, body: raw });
	if (!put.ok) throw new Error(`Storage answered ${put.status}`);
	return ticket.key;
}

export default {
	async email(message: ForwardableEmailMessage, env: Env) {
		if (message.rawSize > 25 * 1024 * 1024) {
			message.setReject("Message rejected: raw email exceeds the 25 MiB receiving limit. Send a download link instead.");
			return;
		}
		const raw = await new Response(message.raw).arrayBuffer();
		const headers = JSON.stringify(Object.fromEntries(message.headers));
		const base = env.MAILFLARE_URL.replace(/\/$/, "");
		let decision: Decision;
		try {
			const uploadKey = raw.byteLength > STORAGE_THRESHOLD_BYTES ? await uploadToStorage(base, env.INBOUND_WEBHOOK_SECRET, raw) : null;
			const post = async (headerMap: string) => {
				const timestamp = String(Math.floor(Date.now() / 1000));
				return fetch(`${base}/api/inbound`, {
					method: "POST",
					headers: {
						"Content-Type": "message/rfc822",
						"X-Mailflare-From": message.from,
						"X-Mailflare-To": message.to,
						"X-Mailflare-Headers": headerMap,
						"X-Mailflare-Timestamp": timestamp,
						"X-Mailflare-Signature": await sign(env.INBOUND_WEBHOOK_SECRET, raw, message.from, message.to, headerMap, timestamp),
						...(uploadKey ? { "X-Mailflare-Upload": uploadKey } : {}),
					},
					body: uploadKey ? undefined : raw,
				});
			};
			let response = await post(headers);
			// Vercel caps request headers (431/494). The map is advisory: the server reads them from the message.
			if (response.status === 431 || response.status === 494) response = await post("{}");
			if (response.status === 413) {
				message.setReject("Message rejected: receiving server says the email is too large. Send a download link instead.");
				return;
			}
			if (!response.ok) throw new Error(`Mailflare answered ${response.status}`);
			decision = (await response.json()) as Decision;
		} catch (error) {
			console.error("Relay to Mailflare failed", error);
			// setReject bounces permanently; throwing is a temporary SMTP failure, so the sender retries.
			throw error;
		}

		if (decision.action === "reject") {
			message.setReject(decision.reason);
			return;
		}
		// Older servers only send forwardTo; newer ones list every destination in forwardToAll.
		const destinations = decision.forwardToAll ?? (decision.forwardTo ? [decision.forwardTo] : []);
		for (const destination of destinations) {
			try {
				await message.forward(destination, new Headers(decision.forwardHeaders ?? {}));
			} catch (error) {
				console.error(`Forward to ${destination} failed`, error);
			}
		}
	},
} satisfies ExportedHandler<Env>;
