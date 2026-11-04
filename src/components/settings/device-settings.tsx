"use client";

import { useEffect, useState } from "react";
import { Bell, Smartphone } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { formatUserDate } from "@/lib/time/utils";
import type { MobileDevice } from "./device-settings-types";
import { loadDevices, signOutDevice } from "./device-settings-utils";

/**
 * Settings > Security card listing phones and tablets signed in with the
 * mobile app. Each holds a device key; signing one out revokes the key and
 * its push registration.
 */
export function DeviceSettings() {
	const { t } = useLanguage();
	const [devices, setDevices] = useState<MobileDevice[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		loadDevices().then(setDevices).catch((err) => setError(err instanceof Error ? err.message : t("devices.loadFailed")));
	}, [t]);

	async function remove(device: MobileDevice) {
		if (!window.confirm(t("devices.signOutConfirm", { name: device.name }))) return;
		setBusy(device.id);
		try {
			await signOutDevice(device.id);
			setDevices((list) => list?.filter((item) => item.id !== device.id) ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : t("devices.loadFailed"));
		} finally {
			setBusy(null);
		}
	}

	if (!devices) return <p className="text-sm text-neutral-500">{error ?? t("devices.loading")}</p>;
	if (devices.length === 0) return <p className="text-sm text-neutral-500">{t("devices.empty")}</p>;

	return (
		<div className="space-y-3">
			{error ? <p className="text-sm text-red-600">{error}</p> : null}
			<ul className="divide-y divide-neutral-100 rounded-2xl bg-neutral-50">
				{devices.map((device) => (
					<li key={device.id} className="flex items-center gap-3 p-4">
						<Smartphone className="h-5 w-5 shrink-0 text-neutral-500" />
						<div className="min-w-0 flex-1">
							<p className="flex items-center gap-2 truncate text-sm font-medium text-neutral-900">
								{device.name}
								{device.pushEnabled ? <Bell className="h-3.5 w-3.5 text-neutral-400" aria-label={t("devices.push")} /> : null}
							</p>
							<p className="truncate text-sm text-neutral-500">
								{t("devices.signedIn", { date: formatUserDate(device.createdAt, { dateStyle: "short" }) })} ·{" "}
								{device.lastUsedAt ? t("apiKeys.lastUsed", { date: formatUserDate(device.lastUsedAt, { dateStyle: "short" }) }) : t("apiKeys.neverUsed")}
							</p>
						</div>
						<Button variant="outline" size="sm" disabled={busy === device.id} onClick={() => remove(device)}>
							{t("devices.signOut")}
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
}
