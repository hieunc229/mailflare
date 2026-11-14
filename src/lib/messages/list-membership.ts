import type { MessageFolder } from "@/hooks/types";
import type { MessageStateSnapshot } from "./actions/types";

/** The fields that decide which folder lists still contain a message. */
export type MessageMembershipFields = Pick<
	MessageStateSnapshot,
	"status" | "folderId" | "snoozedUntil" | "starred"
>;

function snoozedAt(value: string | null | undefined, now: number): boolean {
	if (!value) return false;
	const time = Date.parse(value);
	return Number.isFinite(time) && time > now;
}

/**
 * Mirrors the server's list filters in `src/app/api/messages/route.ts`.
 * A paginated list only contains rows whose current state matches its query.
 */
export function messageMatchesFolder(
	state: MessageMembershipFields,
	folder: MessageFolder,
	folderId?: string | null,
	now = Date.now(),
): boolean {
	if (folderId) {
		// A custom folder query keeps status=received but skips the inbox
		// folder/snooze branch, so snoozed messages stay in the folder.
		return state.status === "received" && state.folderId === folderId;
	}
	if (folder === "starred") return state.starred;
	if (folder === "inbox") {
		return state.status === "received"
			&& state.folderId == null
			&& !snoozedAt(state.snoozedUntil, now);
	}
	if (folder === "snoozed") {
		return state.status === "received"
			&& state.folderId == null
			&& snoozedAt(state.snoozedUntil, now);
	}
	if (folder === "sent") return state.status === "sent";
	if (folder === "scheduled") return state.status === "queued";
	if (folder === "drafts") return state.status === "draft";
	return state.status === folder;
}

/**
 * Reads the list identity back from the request key so cache ingress can apply
 * membership without the hook passing folder/folderId through every call.
 */
export function getListMembershipContext(
	params: URLSearchParams | string,
): { folder: MessageFolder; folderId?: string | null } | null {
	const search = typeof params === "string" ? new URLSearchParams(params) : params;
	const folderId = search.get("folderId");
	if (folderId) return { folder: "inbox", folderId };
	if (search.get("starred") === "true") return { folder: "starred" };
	if (search.get("snoozed") === "true") return { folder: "snoozed" };
	if (search.get("scheduled") === "true") return { folder: "scheduled" };
	const status = search.get("status");
	const direction = search.get("direction");
	if (direction === "inbound" && status === "received") return { folder: "inbox" };
	if (direction === "outbound" && status === "sent") return { folder: "sent" };
	if (direction === "outbound" && status === "draft") return { folder: "drafts" };
	if (status === "archived" || status === "trash" || status === "spam") return { folder: status };
	return null;
}
