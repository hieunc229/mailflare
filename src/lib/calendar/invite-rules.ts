import { getEmailAddress } from "@/lib/email/address";
import { isValidTimeZone, normalizeTimeZone } from "@/lib/time/utils";
import { parseExcludedOccurrences } from "./recurrence";
import type { ParsedInvite } from "./invite";

/** The form `invite_sender` is stored in: the bare address, lower case. */
export function normalizeInviteSender(address: string | null | undefined): string {
	return getEmailAddress(address ?? "").trim().toLowerCase();
}

/**
 * Whether `senderAddress` may change an existing invitation event: only the sender stored in `inviteSender` when the
 * row was created. A row without one has no known sender and is never changed by mail (fails closed).
 */
export function inviteSenderMatches(existing: { inviteSender?: string | null }, senderAddress: string): boolean {
	const sender = normalizeInviteSender(senderAddress);
	return !!sender && !!existing.inviteSender && normalizeInviteSender(existing.inviteSender) === sender;
}

/**
 * The recipient's zone for reading all-day, floating and unresolvable-TZID times: the account's saved zone, else the
 * zone of their most recently updated calendar event that has one, else null (unknown). Invalid names are skipped.
 */
export function chooseRecipientZone(userZone: string | null | undefined, latestEventZone: string | null | undefined): string | null {
	for (const zone of [userZone, latestEventZone]) {
		if (zone && isValidTimeZone(zone)) return normalizeTimeZone(zone);
	}
	return null;
}

/**
 * True when an inbound invitation cannot be applied without knowing the recipient's zone: some time in it was read in
 * the fallback zone. Cancelling a whole series and recording a reply use no times, so they never need it.
 */
export function inboundNeedsRecipientZone(invite: Pick<ParsedInvite, "method" | "recurrenceId" | "usedFallbackZone">): boolean {
	if (!invite.usedFallbackZone || invite.method === "REPLY") return false;
	return !(invite.method === "CANCEL" && !invite.recurrenceId);
}

/** Adds one occurrence start (epoch ms, the unit expandCalendarEvents compares) to an excluded_occurrences JSON array. */
export function addExcludedOccurrence(excludedOccurrences: string | null | undefined, occurrence: Date): string {
	const excluded = parseExcludedOccurrences(excludedOccurrences ?? "[]");
	const at = occurrence.getTime();
	return JSON.stringify(excluded.includes(at) ? excluded : [...excluded, at].sort((a, b) => a - b));
}

/** Existing exclusions plus the invitation's EXDATEs, so refreshing a series never brings a cancelled occurrence back. */
export function mergeExcludedOccurrences(excludedOccurrences: string | null | undefined, dates: Date[]): string {
	// One pass: parse once, add everything to a set, sort and stringify once. Folding addExcludedOccurrence over a long
	// EXDATE list would parse and sort the whole array for every date.
	const merged = new Set(parseExcludedOccurrences(excludedOccurrences ?? "[]"));
	for (const date of dates) merged.add(date.getTime());
	return JSON.stringify([...merged].sort((a, b) => a - b));
}

export type InboundInvitePlan =
	| { action: "ignore"; reason: string }
	| { action: "insert" }
	| { action: "update" }
	| { action: "delete" }
	| { action: "exclude"; occurrence: Date };

type ExistingInviteEvent = { inviteSequence?: number | null };

/**
 * What an incoming REQUEST or CANCEL does to the recipient's calendar, once the sender check has passed.
 * A message about one occurrence (RECURRENCE-ID) never edits or deletes the series: a cancel excludes that occurrence,
 * anything else is ignored. A REQUEST older than the stored one (lower SEQUENCE) arrived out of order and is ignored.
 */
export function planInboundInvite(invite: Pick<ParsedInvite, "method" | "recurrenceId" | "sequence">, existing: ExistingInviteEvent | null | undefined): InboundInvitePlan {
	if (invite.method === "CANCEL") {
		if (!existing) return { action: "ignore", reason: "no event" };
		return invite.recurrenceId ? { action: "exclude", occurrence: invite.recurrenceId } : { action: "delete" };
	}
	if (invite.method !== "REQUEST") return { action: "ignore", reason: "method" };
	if (invite.recurrenceId) return { action: "ignore", reason: "single occurrence" };
	if (!existing) return { action: "insert" };
	if (existing.inviteSequence != null && invite.sequence < existing.inviteSequence) return { action: "ignore", reason: "stale" };
	return { action: "update" };
}

export type InviteAnswerPlan =
	| { action: "none" }
	| { action: "delete" }
	| { action: "exclude"; occurrence: Date }
	| { action: "status" }
	| { action: "upsert" };

/**
 * What answering an invitation from the message (Accept, Maybe, Decline, or Remove on a cancellation) does to the
 * calendar. One occurrence: Decline or a cancel excludes it, Accept and Maybe change nothing. The whole series:
 * Decline or a cancel deletes it; Accept and Maybe write the invitation, or only the answer when the calendar
 * already holds a newer revision (higher SEQUENCE) than this message.
 */
export function planInviteAnswer(invite: Pick<ParsedInvite, "method" | "recurrenceId" | "sequence">, response: "accepted" | "tentative" | "declined", existing: ExistingInviteEvent | null | undefined): InviteAnswerPlan {
	const removing = invite.method === "CANCEL" || response === "declined";
	if (invite.recurrenceId) return removing && existing ? { action: "exclude", occurrence: invite.recurrenceId } : { action: "none" };
	if (removing) return existing ? { action: "delete" } : { action: "none" };
	if (existing?.inviteSequence != null && existing.inviteSequence > invite.sequence) return { action: "status" };
	return { action: "upsert" };
}
