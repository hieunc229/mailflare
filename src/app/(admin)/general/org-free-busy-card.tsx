"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { authFetch } from "@/lib/auth/client";
import { OrgFreeBusyView } from "./org-free-busy-view";

type Settings = { available: boolean; enabled: boolean };

type Answer = { ok: true; data: Settings } | { ok: false; code?: string };

/** The answer as settings, or `ok: false` for any failure: a refusal, a body that is not JSON, a network error. The status is checked before the body is read. */
async function request(init?: RequestInit): Promise<Answer> {
	try {
		const response = await authFetch("/api/admin/calendar-free-busy", init);
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
			return { ok: false, code: typeof body?.code === "string" ? body.code : undefined };
		}
		const data = (await response.json()) as Partial<Settings>;
		return typeof data.enabled === "boolean" && typeof data.available === "boolean" ? { ok: true, data: { available: data.available, enabled: data.enabled } } : { ok: false };
	} catch {
		return { ok: false };
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
		void request({ cache: "no-store" }).then((answer) => {
			if (!active) return;
			if (!answer.ok) { setState("error"); return; }
			setEnabled(answer.data.enabled);
			setAvailable(answer.data.available);
			setState(answer.data.available || answer.data.enabled ? "ready" : "unavailable");
		});
		return () => { active = false; };
	}, [attempt]);

	const change = useCallback(async (next: boolean) => {
		setSaving(true);
		setStatus("");
		const answer = await request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }) });
		if (answer.ok) {
			setEnabled(answer.data.enabled);
			setAvailable(answer.data.available);
			setStatus(t("general.orgFreeBusySaved"));
		} else {
			// What was stored, and whether a licence is still there, may differ from what the page last knew.
			const fresh = await request({ cache: "no-store" });
			if (fresh.ok) { setEnabled(fresh.data.enabled); setAvailable(fresh.data.available); }
			// A licence refusal is already said by the note under the switch once it shows: do not say the same sentence twice.
			const noted = answer.code === "TEAM_REQUIRED" && fresh.ok && !fresh.data.available;
			setStatus(noted ? "" : answer.code === "TEAM_REQUIRED" ? t("general.orgFreeBusyNeedsTeam") : t("general.orgFreeBusySaveFailed"));
		}
		setSaving(false);
	}, [t]);

	return <OrgFreeBusyView state={state} enabled={enabled} available={available} saving={saving} status={status} onChange={(next) => void change(next)} onRetry={() => { setState("loading"); setAttempt((value) => value + 1); }} />;
}
