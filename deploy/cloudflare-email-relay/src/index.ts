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
	| { action: "forward"; forwardTo: string | null; forwardHeaders?: Record<string, string> }
	| { action: "store"; forwardTo: string | null; forwardHeaders?: Record<string, string> };

/** HMAC-SHA256 over `v2\ntimestamp\nfrom\nto\nheaders\n` + raw body; matches src/lib/email/intake-signature.ts. */
async function sign(secret: string, raw: ArrayBuffer, from: string, to: string, headers: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`v2\n${timestamp}\n${from}\n${to}\n${headers}\n`);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
	async email(message: ForwardableEmailMessage, env: Env) {
		if (message.rawSize > 25 * 1024 * 1024) {
			message.setReject("Message rejected: raw email exceeds the 25 MiB receiving limit. Send a download link instead.");
			return;
		}
		const raw = await new Response(message.raw).arrayBuffer();
		const headers = JSON.stringify(Object.fromEntries(message.headers));
		const timestamp = String(Math.floor(Date.now() / 1000));
		let decision: Decision;
		try {
			const response = await fetch(`${env.MAILFLARE_URL.replace(/\/$/, "")}/api/inbound`, {
				method: "POST",
				headers: {
					"Content-Type": "message/rfc822",
					"X-Mailflare-From": message.from,
					"X-Mailflare-To": message.to,
					"X-Mailflare-Headers": headers,
					"X-Mailflare-Timestamp": timestamp,
					"X-Mailflare-Signature": await sign(env.INBOUND_WEBHOOK_SECRET, raw, message.from, message.to, headers, timestamp),
				},
				body: raw,
			});
			if (response.status === 413) {
				message.setReject("Message rejected: receiving server says the email is too large. Send a download link instead.");
				return;
			}
			if (!response.ok) throw new Error(`Mailflare answered ${response.status}`);
			decision = (await response.json()) as Decision;
		} catch (error) {
			console.error("Relay to Mailflare failed", error);
			// A rejection with a temporary-sounding reason makes most senders retry later.
			message.setReject("Mailflare is temporarily unavailable, please retry");
			return;
		}

		if (decision.action === "reject") {
			message.setReject(decision.reason);
			return;
		}
		if (decision.forwardTo) {
			try {
				await message.forward(decision.forwardTo, new Headers(decision.forwardHeaders ?? {}));
			} catch (error) {
				console.error(`Forward to ${decision.forwardTo} failed`, error);
			}
		}
	},
} satisfies ExportedHandler<Env>;
