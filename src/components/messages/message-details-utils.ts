import { authFetch } from "@/lib/auth/client";
import { getEmailAddress, normalizeEmailAddress, parseEmailAddressParts, splitEmailAddressList } from "@/lib/email/address";
import { isSameOrSubdomain } from "@/lib/email/domain-match";
import type { MessageAuthenticationResponse } from "@/lib/email/authentication-types";
import type { MessageDetailsMessage } from "./message-details-types";

export type OriginalSender = {
	/** Display name exactly as it appeared in the message's From header. */
	name: string | null;
	address: string;
	/** Name and address joined for display, or just the address. */
	label: string;
};

/** The sender the message itself claims, not the locally saved contact name. */
export function getOriginalSender(fromAddr: string): OriginalSender {
	const parts = parseEmailAddressParts(fromAddr);
	const address = parts.address || fromAddr.trim();
	const name = parts.name?.trim() || null;
	return {
		name,
		address,
		label: name ? `${name} <${address}>` : address,
	};
}

export function getReplyToEntries(replyTo: string | null | undefined): string[] {
	return splitEmailAddressList(replyTo);
}

/**
 * True when replies leave the From address's domain. Mailings lists often use
 * another mailbox on the same domain, so only a different domain is called out;
 * the details panel still shows every Reply-To address.
 */
export function isReplyToDifferent(message: Pick<MessageDetailsMessage, "fromAddr" | "replyTo">): boolean {
	const entries = getReplyToEntries(message.replyTo);
	if (entries.length === 0) return false;
	const fromDomain = getEmailAddress(message.fromAddr).split("@").pop() ?? "";
	if (!fromDomain) return false;
	return entries.some((entry) => {
		const replyDomain = getEmailAddress(entry).split("@").pop() ?? "";
		return !isSameOrSubdomain(replyDomain, fromDomain);
	});
}

/**
 * True when the display name carries an email address that is not the actual
 * From address. `"support@paypal.com" <attacker@example.net>` is the shape this
 * catches; a brand name without an address does not trigger a warning.
 */
export function hasSenderNameAddressMismatch(message: Pick<MessageDetailsMessage, "fromAddr">): boolean {
	const { name, address } = getOriginalSender(message.fromAddr);
	if (!name) return false;
	const from = normalizeEmailAddress(address);
	const addresses = name.match(/[^\s<>()"']+@[^\s<>()"']+\.[^\s<>()"']+/g) ?? [];
	return addresses.some((candidate) => normalizeEmailAddress(candidate) !== from);
}

export async function fetchMessageAuthentication(
	messageId: string,
	signal?: AbortSignal,
): Promise<MessageAuthenticationResponse> {
	const response = await authFetch(`/api/messages/${encodeURIComponent(messageId)}/authentication`, {
		signal,
		cache: "no-store",
		redirectOnUnauthorized: false,
	});
	if (!response.ok) throw new Error("Unable to load authentication results");
	return (await response.json()) as MessageAuthenticationResponse;
}

/** Statuses where a method rejected the sender rather than being inconclusive. */
const FAILED_AUTHENTICATION_STATUSES = new Set(["FAIL", "SOFTFAIL", "PERMERROR"]);

function isFailedStatus(status: string | null | undefined): boolean {
	return !!status && FAILED_AUTHENTICATION_STATUSES.has(status.toUpperCase());
}

function isPassStatus(status: string | null | undefined): boolean {
	return status?.toUpperCase() === "PASS";
}

/** DMARC pass wins; otherwise flag DMARC failure or failures without a pass. */
function hasAuthenticationWarning(authentication: MessageAuthenticationResponse | null): boolean {
	if (!authentication?.available) return false;
	const dmarc = authentication.dmarc?.status ?? null;
	if (isPassStatus(dmarc)) return false;
	if (isFailedStatus(dmarc)) return true;
	const results = [authentication.spf?.status ?? null, authentication.dkim?.status ?? null];
	const failures = results.filter(isFailedStatus).length;
	const passes = results.filter(isPassStatus).length;
	return failures > 0 && passes === 0;
}

/** DMARC pass already proves alignment; sibling subdomains are valid. */
export function hasDomainMismatchWarning(authentication: MessageAuthenticationResponse | null): boolean {
	if (!authentication?.available) return false;
	if (isPassStatus(authentication.dmarc?.status)) return false;
	return authentication.aligned === false;
}

export function hasPassingAuthenticationCheck(authentication: MessageAuthenticationResponse | null): boolean {
	if (!authentication?.available) return false;
	return [authentication.spf, authentication.dkim, authentication.dmarc]
		.some((method) => isPassStatus(method?.status));
}

export function hasFailingAuthenticationCheck(authentication: MessageAuthenticationResponse | null): boolean {
	if (!authentication?.available) return false;
	return [authentication.spf, authentication.dkim, authentication.dmarc]
		.some((method) => isFailedStatus(method?.status));
}

export type SenderWarningReason = "authentication" | "senderName" | "domain" | "replyTo";

export type SenderWarning = {
	level: "warning";
	/** Most important first. */
	reasons: SenderWarningReason[];
};

/** Reasons a received message needs attention before opening Details. */
export function getSenderWarning(
	message: Pick<MessageDetailsMessage, "direction" | "fromAddr" | "replyTo">,
	authentication: MessageAuthenticationResponse | null,
): SenderWarning | null {
	if (message.direction !== "inbound") return null;
	const reasons: SenderWarningReason[] = [];
	const authenticationWarning = hasAuthenticationWarning(authentication);
	if (authenticationWarning) reasons.push("authentication");
	if (hasSenderNameAddressMismatch(message)) reasons.push("senderName");
	// DMARC failure already reports the unaligned signature.
	if (!authenticationWarning && hasDomainMismatchWarning(authentication)) reasons.push("domain");
	if (isReplyToDifferent(message)) reasons.push("replyTo");
	return reasons.length > 0 ? { level: "warning", reasons } : null;
}
