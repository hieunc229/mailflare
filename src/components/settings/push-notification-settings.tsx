"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Switch } from "@/components/ui/switch";
import {
	disablePushNotifications,
	enablePushNotifications,
	getPushState,
} from "@/lib/push/client";

type State = {
	loading: boolean;
	supported: boolean;
	configured: boolean;
	permission: NotificationPermission | "unsupported";
	subscribed: boolean;
	error: string | null;
};

const initialState: State = {
	loading: true,
	supported: false,
	configured: false,
	permission: "unsupported",
	subscribed: false,
	error: null,
};

export function PushNotificationSettings() {
	const { t } = useLanguage();
	const [state, setState] = useState<State>(initialState);

	useEffect(() => {
		let cancelled = false;
		getPushState()
			.then((next) => {
				if (!cancelled) setState({ ...next, loading: false, error: null });
			})
			.catch((error) => {
				if (!cancelled) {
					setState((current) => ({
						...current,
						loading: false,
						error: error instanceof Error ? error.message : t("settings.push.loadFailed"),
					}));
				}
			});
		return () => {
			cancelled = true;
		};
		// Translations are only read when an error happens; reloading push state on a language change is not needed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const disabled =
		state.loading ||
		!state.supported ||
		(!state.configured && !state.subscribed) ||
		(state.permission === "denied" && !state.subscribed);
	let description = t("settings.push.description");
	if (!state.supported) description = t("settings.push.unsupported");
	else if (!state.configured) description = t("settings.push.notConfigured");
	else if (state.permission === "denied") description = t("settings.push.blocked");

	return (
		<div>
			<label className="flex items-start gap-3 rounded-xl bg-neutral-50 p-4">
				<span className="flex-1">
					<span className="block text-sm font-medium text-neutral-900">{t("settings.push.title")}</span>
					<span className="mt-1 block text-sm text-neutral-500">{description}</span>
				</span>
				<Switch
					checked={state.subscribed}
					disabled={disabled}
					onCheckedChange={(enabled) => {
						setState((current) => ({ ...current, loading: true, error: null }));
						void (enabled ? enablePushNotifications() : disablePushNotifications())
							.then(() => getPushState())
							.then((next) => setState({ ...next, loading: false, error: null }))
							.catch((error) => {
								setState((current) => ({
									...current,
									loading: false,
									error: error instanceof Error ? error.message : t("settings.push.updateFailed"),
								}));
							});
					}}
					aria-label={t("settings.push.toggleLabel")}
				/>
			</label>
			{state.error && <p role="alert" className="mt-2 px-4 text-sm text-red-600">{state.error}</p>}
		</div>
	);
}
