import type { PromotionMode } from "@/lib/promotions/settings";

export type BackfillStatus = "idle" | "pending" | "running" | "done" | "failed";
export type BackfillPatch = Partial<{ backfillStatus: BackfillStatus; backfillStalls: number; backfillError: string | null; backfillCursor: string | null; backfillScanned: number }>;

const MODES: readonly string[] = ["off", "show", "separate"];

export function parseModeBody(body: unknown): { mode: PromotionMode } | { error: string } {
	const mode = body && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
	if (typeof mode !== "string" || !MODES.includes(mode)) return { error: "mode must be off, show or separate" };
	return { mode: mode as PromotionMode };
}

const REQUEUE: BackfillPatch = { backfillStatus: "pending", backfillStalls: 0, backfillError: null, backfillCursor: null, backfillScanned: 0 };

/**
 * Backfill fields to write with a mode change. Moving away from off queues the backfill unless it is
 * pending, running or done; an idle or failed job restarts from a clean state. Saving a non-off mode while the
 * job is failed also restarts it, which is what the Settings "Try again" button sends. Other changes leave it alone.
 */
export function backfillPatchForModeChange(current: { mode: PromotionMode; backfillStatus: BackfillStatus } | null, next: PromotionMode): BackfillPatch {
	const wasOff = !current || current.mode === "off";
	if (next !== "off" && current && !wasOff && current.backfillStatus === "failed") return { ...REQUEUE };
	if (!wasOff || next === "off") return current ? {} : { backfillStatus: "idle" };
	if (current && current.backfillStatus !== "idle" && current.backfillStatus !== "failed") return {};
	return { ...REQUEUE };
}

export function describeBackfill(row: { backfillStatus: BackfillStatus; backfillScanned: number; backfillError: string | null } | null): { status: BackfillStatus; scanned: number; error?: string } {
	if (!row) return { status: "idle", scanned: 0 };
	return row.backfillStatus === "failed" && row.backfillError
		? { status: row.backfillStatus, scanned: row.backfillScanned, error: row.backfillError }
		: { status: row.backfillStatus, scanned: row.backfillScanned };
}

/** A promotion in a `separate` mailbox is not announced (no popup, no push); the list still refreshes. */
export function isSilentPromotion(category: string | null | undefined, mode: PromotionMode | undefined): boolean {
	return category === "promotions" && mode === "separate";
}
