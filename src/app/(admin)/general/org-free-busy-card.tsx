"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { OrgFreeBusyView } from "./org-free-busy-view";

type Settings = { available: boolean; enabled: boolean };

/** The answer as settings, or null for any failure: a refusal, a body that is not JSON, a network error. The status is checked before the body is read. */
async function request(init?: RequestInit): Promise<Settings | null> {
	try {
		const response = await authFetch("/api/admin/calendar-free-busy", init);
		if (!response.ok) return null;
		const data = (await response.json()) as Partial<Settings>;
		return typeof data.enabled === "boolean" && typeof data.available === "boolean" ? { available: data.available, enabled: data.enabled } : null;
	} catch {
		return null;
	}
}

/** The organisation-wide free/busy switch (spec F9 D-10): shown only to Team installations, saved the moment it is flipped. */
export function OrgFreeBusyCard() {
	const { t } = useLanguage();
	const [state, setState] = useState<"loading" | "error" | "ready" | "unavailable">("loading");
	const [enabled, setEnabled] = useState(false);
	const [available, setAvailable] = useState(true);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState("");
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let active = true;
		void request({ cache: "no-store" }).then((data) => {
			if (!active) return;
			if (!data) { setState("error"); return; }
			setEnabled(data.enabled);
			setAvailable(data.available);
			setState(data.available || data.enabled ? "ready" : "unavailable");
		});
		return () => { active = false; };
	}, [attempt]);

	const change = useCallback(async (next: boolean) => {
		setSaving(true);
		setStatus("");
		const data = await request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
		if (data) { setEnabled(data.enabled); setAvailable(data.available); }
		setStatus(data ? t("general.orgFreeBusySaved") : t("general.orgFreeBusySaveFailed"));
		setSaving(false);
	}, [t]);

	return <OrgFreeBusyView state={state} enabled={enabled} available={available} saving={saving} status={status} onChange={(next) => void change(next)} onRetry={() => { setState("loading"); setAttempt((value) => value + 1); }} />;
}
