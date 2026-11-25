import type { TranslationKey } from "@/lib/i18n/types";

export type PromotionModeValue = "off" | "show" | "separate";
export type BackfillState = { status: "idle" | "pending" | "running" | "done" | "failed"; scanned: number; error?: string };

export const PROMOTION_MODE_OPTIONS: ReadonlyArray<{ value: PromotionModeValue; labelKey: TranslationKey }> = [
	{ value: "off", labelKey: "settings.promotions.modeOff" },
	{ value: "show", labelKey: "settings.promotions.modeShow" },
	{ value: "separate", labelKey: "settings.promotions.modeSeparate" },
];

/** The Promotions nav entry exists only when some mailbox in scope has it on. */
export function hasActivePromotions(modes: Record<string, string> | undefined): boolean {
	return !!modes && Object.values(modes).some((mode) => mode !== "off");
}

/** Mirrors the server: changing a mailbox's mode needs full access. */
export function canManagePromotions(permission: string | undefined): boolean {
	return permission === "full_access";
}

export type BackfillNotice =
	| { kind: "none" }
	| { kind: "pending"; key: TranslationKey }
	| { kind: "running" | "done"; key: TranslationKey; vars: { count: number } }
	| { kind: "failed"; key: TranslationKey; error: string | null; retry: true };

/** What the Settings row says about the 90-day sort of existing mail. */
export function getBackfillNotice(backfill: BackfillState | null | undefined): BackfillNotice {
	if (!backfill) return { kind: "none" };
	if (backfill.status === "pending") return { kind: "pending", key: "settings.promotions.backfillPending" };
	if (backfill.status === "running") return { kind: "running", key: "settings.promotions.backfillRunning", vars: { count: backfill.scanned } };
	if (backfill.status === "done") return { kind: "done", key: "settings.promotions.backfillDone", vars: { count: backfill.scanned } };
	if (backfill.status === "failed") return { kind: "failed", key: "settings.promotions.backfillFailed", error: backfill.error ?? null, retry: true };
	return { kind: "none" };
}

/** Message for a failed mode save. 409 MIGRATION_REQUIRED happens on servers that have not applied the promotions migration yet. */
export function getModeErrorKey(status: number, code: string | undefined): TranslationKey {
	if (status === 409 && code === "MIGRATION_REQUIRED") return "settings.promotions.migrationRequired";
	if (status === 403) return "settings.promotions.forbidden";
	return "settings.promotions.saveFailed";
}

export type UnreadDeltaContext = { folder: string; folderId?: string; mode?: PromotionModeValue; category?: string | null };
export type UnreadDeltas = { inboxUnreadDelta?: number; promotionsUnreadDelta?: number };

/**
 * Which folder counts a read/unread flip of `flip` messages moves, from the list the row is in.
 * Inbox rows count toward Inbox, and also toward Promotions when they are promotions in a mailbox that has it on;
 * Promotions rows count toward Promotions, and toward Inbox too in `show` mode, where they are listed in both.
 * `null` when no count moves.
 */
export function unreadDeltas(context: UnreadDeltaContext, flip: number): UnreadDeltas | null {
	if (!flip || context.folderId) return null;
	const on = !!context.mode && context.mode !== "off";
	if (context.folder === "inbox") {
		return { inboxUnreadDelta: flip, ...(on && context.category === "promotions" ? { promotionsUnreadDelta: flip } : {}) };
	}
	if (context.folder === "promotions" && on) {
		return { promotionsUnreadDelta: flip, ...(context.mode === "show" ? { inboxUnreadDelta: flip } : {}) };
	}
	return null;
}

export function mergeUnreadDeltas(a: UnreadDeltas | null, b: UnreadDeltas | null): UnreadDeltas | null {
	if (!a) return b;
	if (!b) return a;
	const inbox = (a.inboxUnreadDelta ?? 0) + (b.inboxUnreadDelta ?? 0);
	const promotions = (a.promotionsUnreadDelta ?? 0) + (b.promotionsUnreadDelta ?? 0);
	return { ...(inbox ? { inboxUnreadDelta: inbox } : {}), ...(promotions ? { promotionsUnreadDelta: promotions } : {}) };
}

export function negateUnreadDeltas(deltas: UnreadDeltas | null): UnreadDeltas | null {
	if (!deltas) return null;
	return {
		...(deltas.inboxUnreadDelta ? { inboxUnreadDelta: -deltas.inboxUnreadDelta } : {}),
		...(deltas.promotionsUnreadDelta ? { promotionsUnreadDelta: -deltas.promotionsUnreadDelta } : {}),
	};
}
