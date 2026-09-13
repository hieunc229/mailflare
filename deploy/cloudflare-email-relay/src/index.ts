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

async function sign(secret: string, raw: ArrayBuffer, from: string, to: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const prefix = new TextEncoder().encode(`${from}\n${to}\n`);
	const data = new Uint8Array(prefix.byteLength + raw.byteLength);
	data.set(prefix, 0);
	data.set(new Uint8Array(raw), prefix.byteLength);
	return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
	async email(message: ForwardableEmailMessage, env: Env) {
		const raw = await new Response(message.raw).arrayBuffer();
		const headers = Object.fromEntries(message.headers);
		let decision: Decision;
		try {
			const response = await fetch(`${env.MAILFLARE_URL.replace(/\/$/, "")}/api/inbound`, {
				method: "POST",
				headers: {
					"Content-Type": "message/rfc822",
					"X-Mailflare-From": message.from,
					"X-Mailflare-To": message.to,
					"X-Mailflare-Headers": JSON.stringify(headers),
					"X-Mailflare-Signature": await sign(env.INBOUND_WEBHOOK_SECRET, raw, message.from, message.to),
				},
				body: raw,
			});
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
