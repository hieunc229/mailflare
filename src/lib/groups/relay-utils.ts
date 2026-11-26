import { GROUP_HEADER } from "@/lib/groups/loop-utils";

/**
 * Everything written for relaying lives under `group-relay/<day>/<kind>/...` (`day` = whole days since the epoch):
 * the shared raw copies (`copy`), the Message-IDs of relayed copies (`mid`), send-cap markers (`rate`), chunk
 * markers (`chunk`), spam skips (`skip`) and cap notices (`capnote`) and used send-as markers (`sendas`). A whole day is deleted by prefix once it is
 * `GROUP_RELAY_TTL_DAYS` old, so cleaning costs the same however much was written, unlike an age filter over one
 * ever-growing listing.
 */
export const GROUP_RELAY_PREFIX = "group-relay/";
export const GROUP_RELAY_TTL_DAYS = 7;
/** How many days back a Message-ID is looked up: as long as the records are kept. */
export const RELAY_MID_LOOKUP_DAYS = GROUP_RELAY_TTL_DAYS;

export const dayOf = (now: Date = new Date()): number => Math.floor(now.getTime() / 86_400_000);
export type RelayKind = "copy" | "mid" | "rate" | "chunk" | "capnote" | "skip" | "sendas";
export const relayKey = (kind: RelayKind, day: number, rest: string): string => `${GROUP_RELAY_PREFIX}${day}/${kind}/${rest}`;
/** External members per group: each one is a billed send through the domain's provider. */
export const MAX_EXTERNAL_MEMBERS = 100;

export type GroupRelayMessage = { kind: "group.relay"; groupId: string; memberId: string; rawR2Key: string; /** Times a provider rate limit has already deferred this relay. */ attempt?: number };

export function isGroupRelayMessage(payload: unknown): payload is GroupRelayMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as Record<string, unknown>;
	return message.kind === "group.relay" && typeof message.groupId === "string" && typeof message.memberId === "string" && typeof message.rawR2Key === "string" && (message.attempt === undefined || typeof message.attempt === "number");
}

/** Same key for every member and every retry of one message to one group (`digest` is the SHA-256 of the raw bytes). */
export async function relayStorageKey(groupId: string, digest: string, now?: Date): Promise<string> {
	return relayKey("copy", dayOf(now), `${await sha256Hex(`group-relay\0${groupId}\0${digest}`)}.eml`);
}

export const relayIdempotencyKey = (message: GroupRelayMessage): string => `${message.groupId}:${message.rawR2Key}:${message.memberId}`;

/** One line, no control characters: these values come from the sender and the admin and land in headers. */
export function plain(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const isAscii = (value: string) => /^[\x20-\x7e]*$/.test(value);

/**
 * RFC 2047 encoded words (`=?UTF-8?B?...?=`), each under 75 characters and cut between characters, joined by spaces.
 * For header text a provider passes through untouched.
 */
export function encodeWords(value: string): string {
	const bytes = new TextEncoder().encode(value);
	const words: string[] = [];
	let start = 0;
	while (start < bytes.length) {
		let end = Math.min(start + 45, bytes.length);
		while (end > start + 1 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
		words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes.subarray(start, end)))}?=`);
		start = end;
	}
	return words.join(" ");
}

/** A phrase for a header: a quoted string when it is plain ASCII, encoded words otherwise (which cannot sit inside quotes). */
export const phrase = (value: string): string => (isAscii(value) ? quote(value) : encodeWords(value));

/** The display name of the relay From: `'Bob <bob@gmail.com>' via Team`. The poster's real address is part of it. */
export function relayFromName(input: { senderName: string; senderAddress: string; groupName: string; groupAddress: string }): string {
	const name = plain(input.senderName).replace(/'/g, "");
	const address = plain(input.senderAddress);
	const who = name ? `${name} <${address}>` : address;
	const group = plain(input.groupName) || input.groupAddress;
	return `'${who}' via ${group}`;
}

/**
 * `"'Bob <bob@gmail.com>' via Team" <team@a.com>`: Google's format, so the provider signs it as our domain and
 * the reader sees who posted. A name such as "ceo@bank.com" cannot stand in for the real address, which always follows
 * it. A quoted string, so `<`, `@` and spaces are legal inside it. With `encode`, non-ASCII text becomes RFC 2047
 * encoded words (SES needs that); without it the raw UTF-8 goes to providers that encode it themselves.
 */
export function relayFrom(input: { senderName: string; senderAddress: string; groupName: string; groupAddress: string }, encode = false): string {
	const name = relayFromName(input);
	return `${encode ? phrase(name) : quote(name)} <${input.groupAddress}>`;
}

/** The poster's From as `X-Original-From`: encoded words for a non-ASCII name, since this header travels as it is written. */
export function relayOriginalFrom(name: string | null, address: string): string {
	const display = plain(name ?? "");
	return display ? `${phrase(display)} <${plain(address)}>` : plain(address);
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
		"List-Id": `${phrase(plain(input.groupName) || address)} <${`${input.localPart}.${input.hostname}`.toLowerCase()}>`,
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
 * provider settings and the send itself. A queue batch holds up to 3 messages in one invocation, and the
 * Free plan allows 50 subrequests per invocation, so a batch runs only as many relays as fit. Each deferral costs
 * more queue operations (the Free plan has 10,000 a day), which is why the batch size is kept at 3 and nothing is deferred.
 */
export const RELAY_COST = 14;
// Under the 50 of an invocation. The outbound consumer's batch size (3) means a batch of relays fits and none is deferred; deferral only guards a larger batch.
export const RELAY_SUBREQUEST_BUDGET = 45;
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
 * guards miss, and a surprise bill. The defaults are overridable with `GROUP_RELAY_GROUP_HOURLY`,
 * `GROUP_RELAY_GROUP_DAILY`, `GROUP_RELAY_INSTALL_HOURLY` and `GROUP_RELAY_INSTALL_DAILY`.
 */
export const GROUP_SENDS_PER_HOUR = 300;
export const GROUP_SENDS_PER_DAY = 1000;
export const INSTALL_SENDS_PER_HOUR = 600;
export const INSTALL_SENDS_PER_DAY = 2000;

export type RelayCaps = { groupHour: number; groupDay: number; installHour: number; installDay: number };
export const DEFAULT_RELAY_CAPS: RelayCaps = { groupHour: GROUP_SENDS_PER_HOUR, groupDay: GROUP_SENDS_PER_DAY, installHour: INSTALL_SENDS_PER_HOUR, installDay: INSTALL_SENDS_PER_DAY };

type CapEnv = { GROUP_RELAY_GROUP_HOURLY?: string; GROUP_RELAY_GROUP_DAILY?: string; GROUP_RELAY_INSTALL_HOURLY?: string; GROUP_RELAY_INSTALL_DAILY?: string };

/** The caps in force: the defaults, each replaced by its environment variable when that is a positive whole number. */
export function relayCaps(env: CapEnv): RelayCaps {
	const read = (value: string | undefined, fallback: number) => {
		const parsed = value === undefined ? NaN : Number(value.trim());
		return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
	};
	return {
		groupHour: read(env.GROUP_RELAY_GROUP_HOURLY, DEFAULT_RELAY_CAPS.groupHour),
		groupDay: read(env.GROUP_RELAY_GROUP_DAILY, DEFAULT_RELAY_CAPS.groupDay),
		installHour: read(env.GROUP_RELAY_INSTALL_HOURLY, DEFAULT_RELAY_CAPS.installHour),
		installDay: read(env.GROUP_RELAY_INSTALL_DAILY, DEFAULT_RELAY_CAPS.installDay),
	};
}

/** Relays per second a chunk releases, so up to 100 of them do not meet a provider's rate limit together. */
export const GROUP_RELAY_PER_SECOND = 2;

/** Longest a relay waits to be released: a group's cap keeps the queue behind it short. */
export const GROUP_RELAY_MAX_DELAY_SECONDS = 600;

/**
 * Seconds before relay number `index` of a message goes out. `ahead` is how many sends of this group were reserved
 * moments ago by other messages, so messages arriving together queue up behind each other instead of all starting at 0.
 */
export const relayDelaySeconds = (index: number, ahead = 0): number => Math.min(GROUP_RELAY_MAX_DELAY_SECONDS, Math.floor((ahead + index) / GROUP_RELAY_PER_SECOND));

/** The receiving provider's own spam or virus verdict (SES); `fail` keeps the message from external members. */
export function relayBlockedByVerdicts(verdicts: { spam?: string; virus?: string } | undefined): boolean {
	return verdicts?.spam?.toLowerCase() === "fail" || verdicts?.virus?.toLowerCase() === "fail";
}

export async function sha256Hex(value: string): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `reserved`: the sends are held while the message is being judged. `approved`: it passed, and later chunks can rely on that. */
export type RateState = "reserved" | "approved";
export type RateEntry = { day: number; hour: number; groupId: string; digest: string; sends: number; state: RateState; uploaded?: Date };

export const relayRateDayPrefix = (day: number): string => `${GROUP_RELAY_PREFIX}${day}/rate/`;

/**
 * One marker per message and group: `group-relay/<day>/rate/<hour>/<group>/<digest>-<sends>-<r|a>`. The key says everything
 * (no object body to read), so one listing of the day's prefix yields every counter. A message counts once however
 * many chunks it has. It is written as `r` (reserved) before the spam check, becomes `a` (approved) when the message
 * passes, and is removed if it is blocked or a cap turns out to be exceeded. Only `a` lets a redelivery skip the checks:
 * a reservation left behind by an attempt that died before its verdict is judged again.
 */
export function relayRateKey(input: { groupId: string; digest: string; sends: number; state: RateState; now?: Date }): string {
	const now = input.now ?? new Date();
	return relayKey("rate", dayOf(now), `${Math.floor(now.getTime() / 3_600_000)}/${input.groupId}/${input.digest}-${input.sends}-${input.state === "approved" ? "a" : "r"}`);
}

export function parseRateKey(key: string): RateEntry | null {
	const match = /^group-relay\/(\d+)\/rate\/(\d+)\/([^/]+)\/([0-9a-f]{64})-(\d+)-([ra])$/.exec(key);
	return match ? { day: Number(match[1]), hour: Number(match[2]), groupId: match[3], digest: match[4], sends: Number(match[5]), state: match[6] === "a" ? "approved" : "reserved" } : null;
}

export type RelayAllowance = { ok: true } | { ok: false; scope: "group" | "installation"; period: "hour" | "day"; limit: number };

/** Whether `sends` more fit, given the day's markers (all of one UTC day): group hour, group day, installation hour, installation day. */
export function planRelayAllowance(entries: RateEntry[], now: { groupId: string; hour: number; day: number; sends: number }, caps: RelayCaps = DEFAULT_RELAY_CAPS): RelayAllowance {
	const total = (filter: (entry: RateEntry) => boolean) => entries.filter(filter).reduce((sum, entry) => sum + entry.sends, 0);
	const checks = [
		{ scope: "group", period: "hour", limit: caps.groupHour, used: total((e) => e.groupId === now.groupId && e.hour === now.hour) },
		{ scope: "group", period: "day", limit: caps.groupDay, used: total((e) => e.groupId === now.groupId) },
		{ scope: "installation", period: "hour", limit: caps.installHour, used: total((e) => e.hour === now.hour) },
		{ scope: "installation", period: "day", limit: caps.installDay, used: total(() => true) },
	] as const;
	const tripped = checks.find((check) => check.used + now.sends > check.limit);
	return tripped ? { ok: false, scope: tripped.scope, period: tripped.period, limit: tripped.limit } : { ok: true };
}

/** Written when a chunk's relays are about to be queued, so a redelivered chunk does not queue (and bill) them again. */
export async function relayChunkKey(groupId: string, digest: string, cursor: string | undefined, now?: Date): Promise<string> {
	return relayKey("chunk", dayOf(now), await sha256Hex(`${groupId}\0${digest}\0${cursor ?? ""}`));
}

/** Written when the spam filters put a message aside, so its later chunks do not judge it again. */
export const relaySkipKey = (groupId: string, digest: string, now?: Date): string => relayKey("skip", dayOf(now), `${groupId}-${digest}`);

/** Written the first time a cap notice is sent for a group, scope and period. */
export const relayCapNoteKey = (groupId: string, scope: string, period: string, bucket: number, now?: Date): string => relayKey("capnote", dayOf(now), `${groupId}-${scope}-${period}-${bucket}`);

/** A provider answering "slow down" (HTTP 429, throttling): retry later without using up the queue's few retries. */
export function isRateLimited(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if ((error as { status?: unknown }).status === 429) return true;
	return /\b429\b|rate.?limit|throttl|too many requests/i.test(String((error as { message?: unknown }).message ?? ""));
}

export const RELAY_MAX_RATE_LIMIT_ATTEMPTS = 6;
/** 15 s, 30 s, 60 s ... capped at 5 minutes. */
export const relayRetryDelay = (attempt: number): number => Math.min(300, 15 * 2 ** attempt);

/** A Message-ID as it is compared and stored: no brackets or spaces, lower case. */
export const normalizeRelayMessageId = (messageId: string): string => messageId.trim().replace(/^<|>$/g, "").trim().toLowerCase();

/**
 * Where the provider's Message-ID of a relayed copy is remembered. A bounce or an auto-reply names that ID, which
 * is how it is traced back to the member the copy was for. Cloudflare sending assigns its own Message-ID and ignores
 * ours, so the ID the provider reports is the only one every provider has.
 */
export async function relayMessageIdKey(messageId: string, now?: Date): Promise<string> {
	return relayKey("mid", dayOf(now), await sha256Hex(normalizeRelayMessageId(messageId)));
}

/** The keys a Message-ID may be stored under: today's and the last few days'. */
export async function relayMessageIdKeys(messageId: string, now: Date = new Date()): Promise<string[]> {
	return Promise.all(Array.from({ length: RELAY_MID_LOOKUP_DAYS }, (_, back) => relayMessageIdKey(messageId, new Date(now.getTime() - back * 86_400_000))));
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

/** Whether unsubscribe links can be built: they need a public HTTPS origin to point at. */
export function unsubscribeOrigin(env: { APP_URL?: string }): string | null {
	const origin = env.APP_URL?.trim().replace(/\/+$/, "");
	return origin && /^https:\/\//i.test(origin) ? origin : null;
}

