import type { CopyDescriptor, MoveTarget } from "@/lib/promotions/move-utils";

export type PromotionToastEntry = {
	id: number;
	copy: CopyDescriptor;
	tone: "ok" | "warn" | "error";
	/** The "Always for <sender>" offer; gone once used or when the move did not fully succeed. */
	always?: { mailboxId: string; senderAddress: string; target: MoveTarget; working: boolean };
};

let current: PromotionToastEntry | null = null;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

export function subscribePromotionToast(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getPromotionToast(): PromotionToastEntry | null {
	return current;
}

/** One toast at a time: a newer move replaces the previous one and its offer. */
export function showPromotionToast(entry: Omit<PromotionToastEntry, "id">): number {
	current = { ...entry, id: nextId++ };
	emit();
	return current.id;
}

export function updatePromotionToast(id: number, patch: Partial<Omit<PromotionToastEntry, "id">>): void {
	if (!current || current.id !== id) return;
	current = { ...current, ...patch };
	emit();
}

export function dismissPromotionToast(id?: number): void {
	if (!current || (id !== undefined && current.id !== id)) return;
	current = null;
	emit();
}
