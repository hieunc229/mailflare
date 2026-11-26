import { GROUP_HEADER } from "@/lib/groups/loop-utils";

/** Raw copies written for relaying live here; the daily sweep removes them after 7 days. */
export const GROUP_RELAY_PREFIX = "group-relay/";
export const GROUP_RELAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** External members per group: each one is a billed send through the domain's provider. */
export const MAX_EXTERNAL_MEMBERS = 100;

export type GroupRelayMessage = { kind: "group.relay"; groupId: string; memberId: string; rawR2Key: string; /** Times a provider rate limit has already deferred this relay. */ attempt?: number };

export function isGroupRelayMessage(payload: unknown): payload is GroupRelayMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as Record<string, unknown>;
	return message.kind === "group.relay" && typeof message.groupId === "string" && typeof message.memberId === "string" && typeof message.rawR2Key === "string" && (message.attempt === undefined || typeof message.attempt === "number");
}

/** Same key for every member and every retry of one message to one group (`digest` is the SHA-256 of the raw bytes). */
export async function relayStorageKey(groupId: string, digest: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`group-relay\0${groupId}\0${digest}`));
	return `${GROUP_RELAY_PREFIX}${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}.eml`;
}

export const relayIdempotencyKey = (message: GroupRelayMessage): string => `${message.groupId}:${message.rawR2Key}:${message.memberId}`;

/** One line, no control characters: these values come from the sender and the admin and land in headers. */
export function plain(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * `"'Bob <bob@gmail.com>' via Team" <team@a.com>`: Google's format, so the provider signs it as our domain and
 * the reader sees who posted. The poster's real address is part of the display name, so a chosen name such as
 * "ceo@bank.com" cannot stand in for it. A quoted string, so `<`, `@` and spaces are legal inside it.
 */
export function relayFrom(input: { senderName: string; senderAddress: string; groupName: string; groupAddress: string }): string {
	const name = plain(input.senderName).replace(/'/g, "");
	const address = plain(input.senderAddress);
	const who = name ? `${name} <${address}>` : address;
	const group = plain(input.groupName) || input.groupAddress;
	return `${quote(`'${who}' via ${group}`)} <${input.groupAddress}>`;
}

export type RelayHeaderInput = {
	groupId: string;
	groupName: string;
	localPart: string;
	hostname: string;
	replyTo: "sender" | "group";
	senderAddress: string;
	/** The poster's From header as received (one line), kept as `X-Original-From`. */
	originalFrom: string;
	unsubscribeUrl: string | null;
	inReplyTo: string | null;
	references: string[];
};

/**
 * The headers of one relayed copy (spec D-7, D-9). The subject and body stay as they were. The installation's
 * `X-Mailflare-Forwarded` marker is deliberately absent: it would hand outsiders a value that switches off forwarding.
 */
export function relayHeaders(input: RelayHeaderInput): Record<string, string> {
	const address = `${input.localPart}@${input.hostname}`.toLowerCase();
	const headers: Record<string, string> = {
		"Reply-To": input.replyTo === "group" ? address : plain(input.senderAddress),
		"List-Id": `${quote(plain(input.groupName) || address)} <${`${input.localPart}.${input.hostname}`.toLowerCase()}>`,
		"List-Post": `<mailto:${address}>`,
		Precedence: "list",
		[GROUP_HEADER]: input.groupId,
		"X-Original-From": plain(input.originalFrom),
	};
	if (input.unsubscribeUrl) {
		headers["List-Unsubscribe"] = `<${input.unsubscribeUrl}>`;
		headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
	}
	if (input.inReplyTo) headers["In-Reply-To"] = plain(input.inReplyTo);
	if (input.references.length) headers.References = input.references.map(plain).join(" ");
	return headers;
}

/** Cloudflare Queues takes at most 100 messages per `sendBatch`. */
export const GROUP_RELAY_BATCH_MAX = 100;

/**
 * Subrequests one relay can use: the group, member and licence lookups, suppression, the raw copy, the
 * provider settings and the send itself. A queue batch holds up to 5 messages in one invocation, and the
 * Free plan allows 50 subrequests per invocation, so a batch runs only as many relays as fit.
 */
export const RELAY_COST = 14;
// Below the 50 of an invocation: other outbound messages (scheduled sends, webhook retries) share the batch and are not budgeted.
export const RELAY_SUBREQUEST_BUDGET = 30;
/** Seconds a deferred relay waits before the queue offers it again. */
export const RELAY_DEFER_SECONDS = 5;

export type RelayBudget = { remaining: number; started: boolean };

export const createRelayBudget = (): RelayBudget => ({ remaining: RELAY_SUBREQUEST_BUDGET, started: false });

/** The first relay of a batch always runs, so the queue makes progress; later ones return false and are re-enqueued, never dropped. */
export function reserveRelay(budget: RelayBudget): boolean {
	if (budget.started && RELAY_COST > budget.remaining) return false;
	budget.started = true;
	budget.remaining -= RELAY_COST;
	return true;
}

/**
 * Sends (messages x external members) allowed per hour and per day, for one group and for the whole installation.
 * Every send is billed on Resend, SES and metered Cloudflare sending, goes out under our domain's name, and the
 * receiving side only authenticates the sender: these are the circuit breakers for a spam run, a loop the other
 * guards miss, and a surprise bill. Low on purpose; an admin who needs more raises the constants.
 */
export const GROUP_SENDS_PER_HOUR = 200;
export const GROUP_SENDS_PER_DAY = 500;
export const INSTALL_SENDS_PER_HOUR = 800;
export const INSTALL_SENDS_PER_DAY = 2000;

/** Relays per second a chunk releases, so up to 100 of them do not meet a provider's rate limit together. */
export const GROUP_RELAY_PER_SECOND = 2;

export const relayDelaySeconds = (index: number): number => Math.floor(index / GROUP_RELAY_PER_SECOND);

/** The receiving provider's own spam or virus verdict (SES); `fail` keeps the message from external members. */
export function relayBlockedByVerdicts(verdicts: { spam?: string; virus?: string } | undefined): boolean {
	return verdicts?.spam?.toLowerCase() === "fail" || verdicts?.virus?.toLowerCase() === "fail";
}

async function sha256Hex(value: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type RateFlag = "ok" | "skip";
export type RateEntry = { day: number; hour: number; groupId: string; digest: string; sends: number; flag: RateFlag };

export const RELAY_RATE_PREFIX = `${GROUP_RELAY_PREFIX}rate/`;
export const relayRateDayPrefix = (day: number): string => `${RELAY_RATE_PREFIX}${day}/`;

/**
 * One marker per message and group: `group-relay/rate/<day>/<hour>/<group>/<digest>-<sends>-<ok|skip>`. The key
 * says everything (no object body to read), so one listing of the day's prefix yields every counter, and the flag
 * keeps the spam verdict for the message's later chunks. A message counts once however many chunks it has.
 */
export function relayRateKey(input: { groupId: string; digest: string; sends: number; flag: RateFlag; now?: Date }): string {
	const hour = Math.floor((input.now ?? new Date()).getTime() / 3_600_000);
	return `${RELAY_RATE_PREFIX}${Math.floor(hour / 24)}/${hour}/${input.groupId}/${input.digest}-${input.sends}-${input.flag}`;
}

export function parseRateKey(key: string): RateEntry | null {
	const match = /^group-relay\/rate\/(\d+)\/(\d+)\/([^/]+)\/([0-9a-f]{64})-(\d+)-(ok|skip)$/.exec(key);
	return match ? { day: Number(match[1]), hour: Number(match[2]), groupId: match[3], digest: match[4], sends: Number(match[5]), flag: match[6] as RateFlag } : null;
}

export type RelayAllowance = { ok: true } | { ok: false; scope: "group" | "installation"; period: "hour" | "day"; limit: number };

/** Whether `sends` more fit, given the day's markers (all of one UTC day): group hour, group day, installation hour, installation day. */
export function planRelayAllowance(entries: RateEntry[], now: { groupId: string; hour: number; day: number; sends: number }): RelayAllowance {
	const total = (filter: (entry: RateEntry) => boolean) => entries.filter(filter).reduce((sum, entry) => sum + entry.sends, 0);
	const checks = [
		{ scope: "group", period: "hour", limit: GROUP_SENDS_PER_HOUR, used: total((e) => e.groupId === now.groupId && e.hour === now.hour) },
		{ scope: "group", period: "day", limit: GROUP_SENDS_PER_DAY, used: total((e) => e.groupId === now.groupId) },
		{ scope: "installation", period: "hour", limit: INSTALL_SENDS_PER_HOUR, used: total((e) => e.hour === now.hour) },
		{ scope: "installation", period: "day", limit: INSTALL_SENDS_PER_DAY, used: total(() => true) },
	] as const;
	const tripped = checks.find((check) => check.used + now.sends > check.limit);
	return tripped ? { ok: false, scope: tripped.scope, period: tripped.period, limit: tripped.limit } : { ok: true };
}

/** Written once a chunk's relays are queued, so a redelivered chunk does not queue (and bill) them again. */
export async function relayChunkKey(groupId: string, digest: string, cursor: string | undefined): Promise<string> {
	return `${GROUP_RELAY_PREFIX}chunk/${await sha256Hex(`${groupId}\0${digest}\0${cursor ?? ""}`)}`;
}

/** A provider answering "slow down" (HTTP 429, throttling): retry later without using up the queue's few retries. */
export function isRateLimited(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ((error as { status?: unknown }).status === 429) return true;
	return /\b429\b|rate.?limit|throttl|too many requests/i.test(String((error as { message?: unknown }).message ?? ""));
}

export const RELAY_MAX_RATE_LIMIT_ATTEMPTS = 6;
/** 15 s, 30 s, 60 s ... capped at 5 minutes. */
export const relayRetryDelay = (attempt: number): number => Math.min(300, 15 * 2 ** attempt);

/**
 * Where the provider's Message-ID of a relayed copy is remembered. A bounce or an auto-reply names that ID, which
 * is how it is traced back to the member the copy was for. Cloudflare sending assigns its own Message-ID and ignores
 * ours, so the ID the provider reports is the only one every provider has.
 */
export async function relayMessageIdKey(messageId: string): Promise<string> {
	return `${GROUP_RELAY_PREFIX}mid/${await sha256Hex(messageId.trim().replace(/^<|>$/g, "").toLowerCase())}`;
}

/** The unfolded value of one header from the header block of a raw message (first 256 KiB), or null. */
export function rawHeaderValue(raw: ArrayBuffer, name: string): string | null {
	const text = new TextDecoder("latin1").decode(new Uint8Array(raw, 0, Math.min(raw.byteLength, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const wanted = `${name.toLowerCase()}:`;
	for (const line of block.split(/\r?\n/)) if (line.toLowerCase().startsWith(wanted)) return line.slice(wanted.length).trim();
	return null;
}
