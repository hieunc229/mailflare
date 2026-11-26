/**
 * What both Vercel queue backends share, and the QStash one. Vercel Queues (vercel-queues.ts) is the default;
 * setting the QStash variables switches to QStash, which posts each message back to
 * `/api/internal/queue/<name>`, signed. There retries are ours (a re-published message with a higher attempt
 * number), so the delays and limits match wrangler.jsonc whatever the QStash plan allows.
 */
export type QueueName = "inbound" | "outbound" | "agent";

export type QueueEnvelope = { body: unknown; attempt: number };

/** What travels on the Vercel Queues topic. `tick` is the five-minute schedule. */
export type VercelQueueMessage = { queue: QueueName; body: unknown } | { queue: "tick" };

/** The `VERCEL_QUEUES` entry of the Vercel env, present when Vercel Queues is the backend. */
export type VercelQueues = {
	handleCallback: (typeof import("@vercel/queue"))["handleCallback"];
	/** Asks for the next five-minute run. Safe to call often; never throws. */
	ensureTick: () => Promise<void>;
};

export type QStashConfig = { token: string; url: string; currentSigningKey: string; nextSigningKey: string };

type Vars = Record<string, string | undefined>;

/** Same retry counts as the consumers in wrangler.jsonc. */
export const QUEUE_MAX_RETRIES: Record<QueueName, number> = { inbound: 12, outbound: 3, agent: 3 };

export const QUEUE_ROUTE_PREFIX = "/api/internal/queue";

export function isQueueName(value: string): value is QueueName {
	return value === "inbound" || value === "outbound" || value === "agent";
}

export function queueDestination(appUrl: string, name: QueueName): string {
	return `${appUrl.replace(/\/+$/, "")}${QUEUE_ROUTE_PREFIX}/${name}`;
}

export function readQStashConfig(vars: Vars): QStashConfig | null {
	const token = vars.QSTASH_TOKEN?.trim();
	const currentSigningKey = vars.QSTASH_CURRENT_SIGNING_KEY?.trim();
	const nextSigningKey = vars.QSTASH_NEXT_SIGNING_KEY?.trim();
	if (!token || !currentSigningKey || !nextSigningKey) return null;
	return { token, currentSigningKey, nextSigningKey, url: (vars.QSTASH_URL?.trim() || "https://qstash.upstash.io").replace(/\/+$/, "") };
}

/**
 * An IMAP password only ever travels in its queue message; it must not sit in an external queue.
 * (IMAP import needs Workers sockets, so it could not run here anyway.)
 */
export function assertQueueable(body: unknown): void {
	if (typeof body === "object" && body !== null && "imapPassword" in body) throw new Error("IMAP import is not supported on Vercel");
}

/** The `Queue` binding's producer methods over one publish call. */
export function queueProducer(publish: (body: unknown, delaySeconds?: number) => Promise<void>) {
	const send = (body: unknown, options?: { delaySeconds?: number }) => publish(body, options?.delaySeconds);
	return {
		send,
		async sendBatch(messages: Iterable<{ body: unknown; delaySeconds?: number }>) {
			for (const message of messages) await send(message.body, { delaySeconds: message.delaySeconds });
		},
		async metrics() {
			return { backlogCount: 0 };
		},
	};
}

export async function publishToQStash(config: QStashConfig, destination: string, envelope: QueueEnvelope, delaySeconds = 0): Promise<void> {
	assertQueueable(envelope.body);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${config.token}`,
		"Content-Type": "application/json",
		// Covers deliveries our own retry cannot see: the function crashed or timed out.
		"Upstash-Retries": "3",
	};
	if (delaySeconds > 0) headers["Upstash-Delay"] = `${Math.ceil(delaySeconds)}s`;
	const response = await fetch(`${config.url}/v2/publish/${destination}`, { method: "POST", headers, body: JSON.stringify(envelope) });
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`QStash publish failed (${response.status}): ${detail.slice(0, 300)}`);
	}
}

export function openQStashQueue(name: QueueName, config: QStashConfig, appUrl: string) {
	const destination = queueDestination(appUrl, name);
	return queueProducer((body, delaySeconds) => publishToQStash(config, destination, { body, attempt: 1 }, delaySeconds));
}

function base64UrlToBytes(value: string): Uint8Array {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
}

function bytesToBase64Url(bytes: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const CLOCK_SKEW_SECONDS = 60;

async function verifyWithKey(key: string, token: string, body: string, destination: string, nowSeconds: number): Promise<boolean> {
	const [header, payload, signature, extra] = token.split(".");
	if (!header || !payload || !signature || extra !== undefined) return false;
	try {
		const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as Record<string, unknown>;
		if (decode(header).alg !== "HS256") return false;
		const imported = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
		const signed = new TextEncoder().encode(`${header}.${payload}`);
		if (!(await crypto.subtle.verify("HMAC", imported, base64UrlToBytes(signature) as BufferSource, signed))) return false;
		const claims = decode(payload);
		if (claims.iss !== "Upstash" || claims.sub !== destination) return false;
		if (typeof claims.exp !== "number" || nowSeconds > claims.exp + CLOCK_SKEW_SECONDS) return false;
		if (typeof claims.nbf === "number" && nowSeconds < claims.nbf - CLOCK_SKEW_SECONDS) return false;
		const digest = bytesToBase64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
		return typeof claims.body === "string" && claims.body.replace(/=+$/, "") === digest;
	} catch {
		return false;
	}
}

/** The `Upstash-Signature` check: signed with the current or next key, for this URL and exactly this body. */
export async function verifyQStashSignature(config: Pick<QStashConfig, "currentSigningKey" | "nextSigningKey">, signature: string | null, body: string, destination: string, now = new Date()): Promise<boolean> {
	if (!signature) return false;
	const seconds = Math.floor(now.getTime() / 1000);
	return (await verifyWithKey(config.currentSigningKey, signature, body, destination, seconds))
		|| verifyWithKey(config.nextSigningKey, signature, body, destination, seconds);
}
