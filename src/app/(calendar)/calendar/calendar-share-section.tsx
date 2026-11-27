"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import type { CalendarGrantRole, ShareEntry } from "@/lib/calendar/shares-types";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { addShare, changeShareRole, loadShares, removeShare, runRemove } from "./calendar-share-api";
import { calendarChanged } from "./calendar-state";
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

	const settle = (result: Awaited<ReturnType<typeof loadShares>>) => {
		if (result.ok) { setShares(result.shares); setState("ready"); } else setState("error");
	};
	// Not through `settle`: an effect that calls a function setting state runs it synchronously, which the lint rule rightly dislikes.
	useEffect(() => {
		let active = true;
		void loadShares(calendarId).then((result) => {
			if (!active) return;
			if (result.ok) { setShares(result.shares); setState("ready"); } else setState("error");
		});
		return () => { active = false; };
	}, [calendarId]);
	const reload = async () => settle(await loadShares(calendarId));

	async function add() {
		setAdding(true);
		setError("");
		const result = await addShare(calendarId, email.trim(), role);
		setAdding(false);
		if (!result.ok) { setError(t(shareErrorKey(result.status, result.code) as never)); return; }
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
		if (!result.ok) { setError(t(shareErrorKey(result.status) as never)); if (result.status === 404) void reload(); return; }
		setShares((current) => current.map((entry) => (entry.id === share.id ? result.share : entry)));
		toast.success(t("calendar.share.roleChanged", { name: share.name || share.email }));
	}

	async function remove(share: ShareEntry) {
		setPendingId(share.id);
		setError("");
		const outcome = await runRemove({ share, calendarId, confirm: (name) => confirmDestructive(t("calendar.share.removeConfirm", { name })), remove: removeShare });
		setPendingId(null);
		if (outcome.kind === "cancelled") return;
		if (outcome.kind === "failed") { setError(t(shareErrorKey(outcome.status, outcome.code) as never)); if (outcome.status === 404) void reload(); return; }
		toast.success(t("calendar.share.removed", { name: share.name || share.email }));
		// A manager who removed themselves no longer has this calendar's settings: close the dialog and refresh the list.
		if (outcome.kind === "self") { calendarChanged("updated", calendarId); return; }
		setShares((current) => current.filter((entry) => entry.id !== share.id));
	}

	return <ShareView state={state} shares={shares} pendingId={pendingId} email={email} role={role} adding={adding} error={error}
		onEmail={setEmail} onRole={setRole} onAdd={() => void add()} onChangeRole={(share, next) => void change(share, next)} onRemove={(share) => void remove(share)} onRetry={() => { setState("loading"); void reload(); }} />;
}
