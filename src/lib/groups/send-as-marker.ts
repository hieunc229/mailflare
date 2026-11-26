import { readTrustedDmarcResult } from "@/lib/spam/analyzers/authentication";
import type { ProviderVerdicts } from "@/lib/spam/types";
import { getUnsubscribeSecret } from "@/lib/groups/unsubscribe-secret";
import { singleSenderAddress } from "@/lib/groups/policy-utils";

export const SEND_AS_HEADER = "X-Mailflare-Send-As";

async function mac(secret: string, messageId: string, groupId: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`mailflare-send-as\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${messageId}\n${groupId}`));
	return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The marker on a message sent as a group: it names the stored outbound message and the group, signed with the
 * installation's key, so mail that comes back to the group can be told apart from a forged From. Null when the key
 * cannot be read: the send still goes out, without the shortcut (the post then follows the group's normal policy).
 */
export async function signSendAs(env: CloudflareEnv, input: { messageId: string; groupId: string }): Promise<string | null> {
	try {
		return `v1.${input.messageId}.${input.groupId}.${await mac(await getUnsubscribeSecret(env), input.messageId, input.groupId)}`;
	} catch (error) {
		console.warn("Signing the send-as marker failed", error);
		return null;
	}
}

export async function verifySendAs(env: CloudflareEnv, value: string | null | undefined, groupId: string): Promise<{ messageId: string } | null> {
	const [version, messageId, markerGroup, signature, ...rest] = (value ?? "").trim().split(".");
	if (version !== "v1" || !messageId || markerGroup !== groupId || !signature || rest.length) return null;
	let expected: string;
	try {
		expected = await mac(await getUnsubscribeSecret(env), messageId, groupId);
	} catch {
		return null;
	}
	if (signature.length !== expected.length) return null;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
	return diff === 0 ? { messageId } : null;
}

/**
 * A post that one of our own send-as members made to this group: From is the group's own address, the receiver
 * vouches for it with a DMARC pass, and the marker verifies. Nobody outside can produce all three.
 */
export async function isSignedSendAs(
	env: CloudflareEnv,
	input: { headers: Record<string, string>; verdicts?: ProviderVerdicts; groupId: string; groupAddress: string; from: string | null | undefined },
): Promise<{ messageId: string } | null> {
	if (singleSenderAddress(input.from ?? "") !== input.groupAddress.toLowerCase()) return null;
	if (readTrustedDmarcResult(input.headers, input.verdicts) !== "pass") return null;
	return verifySendAs(env, input.headers[SEND_AS_HEADER.toLowerCase()], input.groupId);
}
