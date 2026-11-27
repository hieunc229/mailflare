"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { useLanguage } from "@/components/language-provider";
import { confirmDestructive } from "@/components/ui/confirm-dialog";
import { loadPublishStatus, publishUrls, turnOffPublish, turnOnPublish } from "./publish-api";
import { PublishView } from "./publish-view";

/** The "Publish free/busy" card (spec F9 D-11): a private link to the owner's busy times. */
export function PublishCard() {
	const { t } = useLanguage();
	const [state, setState] = useState<"loading" | "error" | "off" | "on">("loading");
	const [since, setSince] = useState("");
	const [urls, setUrls] = useState<{ ifb: string; ics: string } | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		let active = true;
		void loadPublishStatus().then((result) => {
			if (!active) return;
			if (!result.ok) { setState("error"); return; }
			setSince(result.status.enabled && result.status.createdAt ? new Date(result.status.createdAt).toLocaleDateString() : "");
			setState(result.status.enabled ? "on" : "off");
		});
		return () => { active = false; };
	}, [attempt]);

	async function turnOn() {
		setPending(true);
		setError("");
		const result = await turnOnPublish();
		setPending(false);
		if (!result.ok) { setError(t("calendar.publish.failed")); return; }
		setUrls(result.key ? publishUrls(window.location.origin, result.key) : null);
		setSince(new Date().toLocaleDateString());
		setState("on");
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

	return <PublishView state={state} urls={urls} since={since} pending={pending} error={error} onTurnOn={() => void turnOn()} onTurnOff={() => void turnOff()} onCopy={(url) => void copy(url)} onRetry={() => { setState("loading"); setAttempt((value) => value + 1); }} />;
}
