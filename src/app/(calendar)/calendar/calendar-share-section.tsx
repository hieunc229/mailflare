"use client";

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import type { CalendarGrantRole, ShareEntry } from "@/lib/calendar/shares-types";
import { addShare, changeShareRole, loadShares, removeShare } from "./calendar-share-api";
import { ShareView } from "./calendar-share-view";
import { shareErrorKey } from "./calendar-list-utils";

/** Who a calendar is shared with, for its owner and managers. Remounted per calendar (keyed by the caller). */
export function ShareSection({ calendarId }: { calendarId: string }) {
	const { t } = useLanguage();
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [shares, setShares] = useState<ShareEntry[]>([]);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<CalendarGrantRole>("read");
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		setState("loading");
		const result = await loadShares(calendarId);
		if (!result.ok) { setState("error"); return; }
		setShares(result.shares);
		setState("ready");
	}, [calendarId]);
	useEffect(() => { void load(); }, [load]);

	async function add() {
		setAdding(true);
		setError("");
		const result = await addShare(calendarId, email.trim(), role);
		setAdding(false);
		if (!result.ok) { setError(t(shareErrorKey(result.status) as never)); return; }
		setShares((current) => [...current, result.share]);
		setEmail("");
		toast.success(t("calendar.share.added", { name: result.share.name || result.share.email }));
	}

	async function change(share: ShareEntry, next: CalendarGrantRole) {
		if (next === share.role) return;
		setPendingId(share.id);
		setError("");
		const result = await changeShareRole(calendarId, share.id, next);
		setPendingId(null);
		if (!result.ok) { setError(t(shareErrorKey(result.status) as never)); if (result.status === 404) void load(); return; }
		setShares((current) => current.map((entry) => (entry.id === share.id ? result.share : entry)));
		toast.success(t("calendar.share.roleChanged", { name: share.name || share.email }));
	}

	async function remove(share: ShareEntry) {
		setPendingId(share.id);
		setError("");
		const result = await removeShare(calendarId, share.id);
		setPendingId(null);
		if (!result.ok) { setError(t(shareErrorKey(result.status) as never)); if (result.status === 404) void load(); return; }
		setShares((current) => current.filter((entry) => entry.id !== share.id));
		toast.success(t("calendar.share.removed", { name: share.name || share.email }));
	}

	return <ShareView state={state} shares={shares} pendingId={pendingId} email={email} role={role} adding={adding} error={error}
		onEmail={setEmail} onRole={setRole} onAdd={() => void add()} onChangeRole={(share, next) => void change(share, next)} onRemove={(share) => void remove(share)} onRetry={() => void load()} />;
}
