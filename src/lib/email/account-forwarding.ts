import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getEmailAddress } from "@/lib/email/address";
import { resolveInboundAddress } from "@/lib/email/routing";
import { getLicenseEntitlements } from "@/lib/licenses/service";

export const MAILFLARE_FORWARDED_HEADER = "X-Mailflare-Forwarded";

/** Server-only secrets the loop-guard marker can be keyed with, in order of preference. */
function markerSecret(env: CloudflareEnv): string | null {
	return env.CF_TOKEN || env.CF_API_KEY || env.INBOUND_WEBHOOK_SECRET || null;
}

async function markerMac(secret: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`mailflare-forwarded\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("forwarded"));
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The loop-guard marker added to mail we forward. It is keyed with a server secret, so a sender
 * cannot add a bare `X-Mailflare-Forwarded: 1` to switch forwarding off. It is not bound to a
 * recipient because a forward between two of our own mailboxes must still be recognised. Without
 * any server secret configured it falls back to the unsigned "1".
 */
export async function forwardedMarker(env: CloudflareEnv): Promise<string> {
	const secret = markerSecret(env);
	return secret ? `v1.${await markerMac(secret)}` : "1";
}

export async function isForwardedMarkerValid(env: CloudflareEnv, value: string | null | undefined): Promise<boolean> {
	if (!value) return false;
	const secret = markerSecret(env);
	if (!secret) return value === "1";
	const expected = `v1.${await markerMac(secret)}`;
	if (value.length !== expected.length) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ value.charCodeAt(index);
	return diff === 0;
}

export async function getAccountForwardingDestination(
	env: CloudflareEnv,
	recipient: string,
): Promise<string | null> {
	if (!(await getLicenseEntitlements(env)).canForwardEmail) return null;
	const db = getDb(env);
	const decision = await resolveInboundAddress(db, recipient);
	if (!decision?.mailbox) return null;
	const [account] = await db
		.select({ forwardingEmail: users.forwardingEmail })
		.from(users)
		.where(eq(users.id, decision.mailbox.userId))
		.limit(1);
	const destination = account?.forwardingEmail?.trim() ?? "";
	if (!destination || getEmailAddress(destination).toLowerCase() === getEmailAddress(recipient).toLowerCase()) {
		return null;
	}
	return destination;
}
