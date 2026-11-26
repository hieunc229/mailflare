import { GROUP_HEADER } from "@/lib/groups/loop-utils";

/** Raw copies written for relaying live here; the daily sweep removes them after 7 days. */
export const GROUP_RELAY_PREFIX = "group-relay/";
export const GROUP_RELAY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** External members per group: each one is a billed send through the domain's provider. */
export const MAX_EXTERNAL_MEMBERS = 100;

export type GroupRelayMessage = { kind: "group.relay"; groupId: string; memberId: string; rawR2Key: string };

export function isGroupRelayMessage(payload: unknown): payload is GroupRelayMessage {
	if (typeof payload !== "object" || payload === null) return false;
	const message = payload as Record<string, unknown>;
	return message.kind === "group.relay" && typeof message.groupId === "string" && typeof message.memberId === "string" && typeof message.rawR2Key === "string";
}

/** Same key for every member and every retry of one message to one group (`digest` is the SHA-256 of the raw bytes). */
export async function relayStorageKey(groupId: string, digest: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`group-relay\0${groupId}\0${digest}`));
	return `${GROUP_RELAY_PREFIX}${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}.eml`;
}

export const relayIdempotencyKey = (message: GroupRelayMessage): string => `${message.groupId}:${message.rawR2Key}:${message.memberId}`;

/** One line, no control characters: these values come from the sender and the admin and land in headers. */
function plain(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** `"'Bob' via Team" <team@a.com>`: Google's format, so the provider signs it as our domain and the reader sees who posted. */
export function relayFrom(input: { senderName: string; senderAddress: string; groupName: string; groupAddress: string }): string {
	const who = plain(input.senderName) || plain(input.senderAddress);
	const group = plain(input.groupName) || input.groupAddress;
	return `${quote(`'${who.replace(/'/g, "")}' via ${group}`)} <${input.groupAddress}>`;
}

export type RelayHeaderInput = {
	groupId: string;
	groupName: string;
	localPart: string;
	hostname: string;
	replyTo: "sender" | "group";
	senderAddress: string;
	/** The keyed `X-Mailflare-Forwarded` value (`forwardedMarker`). */
	marker: string;
	unsubscribeUrl: string | null;
	inReplyTo: string | null;
	references: string[];
};

/** The headers of one relayed copy (spec D-7, D-9). The subject and body stay as they were. */
export function relayHeaders(input: RelayHeaderInput): Record<string, string> {
	const address = `${input.localPart}@${input.hostname}`.toLowerCase();
	const headers: Record<string, string> = {
		"Reply-To": input.replyTo === "group" ? address : plain(input.senderAddress),
		"List-Id": `${quote(plain(input.groupName) || address)} <${`${input.localPart}.${input.hostname}`.toLowerCase()}>`,
		"List-Post": `<mailto:${address}>`,
		Precedence: "list",
		[GROUP_HEADER]: input.groupId,
		"X-Mailflare-Forwarded": input.marker,
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
export const RELAY_COST = 12;
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
