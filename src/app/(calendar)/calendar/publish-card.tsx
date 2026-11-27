"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { loadPublishStatus, publishUrls, turnOffPublish, turnOnPublish } from "./publish-api";
import { PublishView } from "./publish-view";

/** The "Publish free/busy" card (spec F9 D-11): a private link to the owner's busy times. */
export function PublishCard({ hideTitle = false }: { hideTitle?: boolean }) {
	const { t } = useLanguage();
	const [state, setState] = useState<"loading" | "error" | "off" | "on">("loading");
	const [since, setSince] = useState("");
	const [urls, setUrls] = useState<{ ifb: string; ics: string } | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);

	function show(result: Awaited<ReturnType<typeof loadPublishStatus>>) {
		if (!result.ok) { setState("error"); return; }
		setSince(result.status.enabled && result.status.createdAt ? new Date(result.status.createdAt).toLocaleDateString() : "");
		setState(result.status.enabled ? "on" : "off");
	}

	useEffect(() => {
		let active = true;
		void loadPublishStatus().then((result) => { if (active) show(result); });
		return () => { active = false; };
	}, [attempt]);

	async function turnOn() {
		setPending(true);
		setError("");
		const result = await turnOnPublish();
		setPending(false);
		if (!result.ok) { setError(t("calendar.publish.failed")); return; }
		if (result.key) { setUrls(publishUrls(window.location.origin, result.key)); setSince(new Date().toLocaleDateString()); setState("on"); return; }
		// Already on (another tab or device made it): nothing to show but the real date, so ask again.
		show(await loadPublishStatus());
	}

	async function turnOff() {
		setError("");
		if (!await confirmDestructive({ message: t("calendar.publish.confirmOff"), confirmLabel: t("calendar.publish.turnOff") })) return;
		setPending(true);
		const result = await turnOffPublish();
		setPending(false);
		if (!result.ok) { setError(t("calendar.publish.failed")); return; }
		setUrls(null);
		setState("off");
		toast.success(t("calendar.publish.turnedOff"));
	}

	async function copy(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			toast.success(t("calendar.publish.copied"));
		} catch {
			toast.error(t("calendar.publish.copyFailed"));
		}
	}

	return <PublishView state={state} urls={urls} since={since} pending={pending} error={error} onTurnOn={() => void turnOn()} onTurnOff={() => void turnOff()} onCopy={(url) => void copy(url)} onRetry={() => { setState("loading"); setAttempt((value) => value + 1); }} hideTitle={hideTitle} />;
}
