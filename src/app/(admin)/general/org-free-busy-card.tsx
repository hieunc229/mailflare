"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { OrgFreeBusyView } from "./org-free-busy-view";

type Settings = { available: boolean; enabled: boolean; error?: string };

/** The organisation-wide free/busy switch (spec F9 D-10): shown only to Team installations, saved the moment it is flipped. */
export function OrgFreeBusyCard() {
	const { t } = useLanguage();
	const [state, setState] = useState<"loading" | "error" | "ready" | "unavailable">("loading");
	const [enabled, setEnabled] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState("");
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let active = true;
		void authFetch("/api/admin/calendar-free-busy", { cache: "no-store" }).then(async (response) => {
			const data = (await response.json()) as Settings;
			if (!active) return;
			if (!response.ok) { setState("error"); return; }
			setEnabled(data.enabled);
			setState(data.available ? "ready" : "unavailable");
		}).catch(() => { if (active) setState("error"); });
		return () => { active = false; };
	}, [attempt]);

	const change = useCallback(async (next: boolean) => {
		setSaving(true);
		setStatus("");
		try {
			const response = await authFetch("/api/admin/calendar-free-busy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
			const data = (await response.json()) as Settings;
			if (!response.ok) throw new Error(data.error ?? t("general.saveFailed"));
			setEnabled(data.enabled);
			setStatus(t("general.orgFreeBusySaved"));
		} catch (error) {
			setStatus(error instanceof Error ? error.message : t("general.saveFailed"));
		} finally { setSaving(false); }
	}, [t]);

	return <OrgFreeBusyView state={state} enabled={enabled} saving={saving} status={status} onChange={(next) => void change(next)} onRetry={() => { setState("loading"); setAttempt((value) => value + 1); }} />;
}
