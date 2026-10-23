"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requestJson } from "./api";
import { ROW_GRID, StatusBadge } from "./status-row";
import { probeTrackingHost } from "./tracking-host-utils";
import type { Domain } from "./types";

type TrackingHostResponse = { hostname: string | null; available: boolean };

/** The hostname that serves this domain's read-receipt pixels, so they match the sender domain. */
export default function TrackingHostSection({ domain }: { domain: Domain }) {
	const { t } = useLanguage();
	const [saved, setSaved] = useState<TrackingHostResponse | null>(null);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [probe, setProbe] = useState<{ hostname: string; ok: boolean } | null>(null);

	useEffect(() => {
		let active = true;
		requestJson<TrackingHostResponse>(`/api/domains/${domain.id}/tracking`, "GET")
			.then((data) => {
				if (!active) return;
				setSaved(data);
				setValue(data.hostname ?? "");
			})
			.catch(() => { if (active) setSaved({ hostname: null, available: false }); });
		return () => { active = false; };
	}, [domain.id]);

	useEffect(() => {
		const hostname = saved?.hostname;
		if (!hostname) return;
		let active = true;
		void probeTrackingHost(hostname).then((ok) => { if (active) setProbe({ hostname, ok }); });
		return () => { active = false; };
	}, [saved?.hostname]);

	async function save(hostname: string | null) {
		setBusy(true);
		setError("");
		try {
			const data = await requestJson<TrackingHostResponse>(`/api/domains/${domain.id}/tracking`, "PUT", { hostname });
			setSaved(data);
			setValue(data.hostname ?? "");
		} catch (err) {
			setError(err instanceof Error ? err.message : t("domains.requestFailed"));
		} finally {
			setBusy(false);
		}
	}

	if (!saved) return null;
	const reachable = !saved.hostname ? null : probe?.hostname !== saved.hostname ? "checking" : probe.ok ? "ok" : "failed";
	const ok = !!saved.hostname && reachable === "ok";
	const failed = !!saved.hostname && reachable === "failed";
	const status = !saved.hostname
		? t("domains.tracking.notSet")
		: reachable === "ok"
			? t("domains.tracking.reachable", { host: saved.hostname })
			: reachable === "failed"
				? t("domains.tracking.unreachable", { host: saved.hostname })
				: t("domains.checking");

	return (
		<section className="mt-6">
			<h2 className="text-base font-semibold text-neutral-900">{t("domains.tracking.title")}</h2>
			<p className="mt-0.5 text-sm text-neutral-500">{t("domains.tracking.description")}</p>
			<ul className="mt-3 space-y-2">
				<li className={`${ROW_GRID} ${ok ? "bg-green-50" : failed ? "bg-amber-50" : "bg-neutral-50"}`}>
					<StatusBadge ok={ok} tone="neutral" />
					<span className="min-w-0">
						<span className="block font-medium text-neutral-900">{t("domains.tracking.host")}</span>
						<span className="block text-xs text-neutral-500">{t("domains.tracking.hostHint")}</span>
					</span>
					<div className="min-w-0 break-words text-neutral-500">
						{saved.available ? (
							<div className="space-y-2">
								<form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(value); }}>
									<Input
										aria-label={t("domains.tracking.host")}
										placeholder={`mail.${domain.hostname}`}
										value={value}
										onChange={(event) => setValue(event.target.value)}
										className="max-w-xs bg-white"
										autoComplete="off"
										spellCheck={false}
									/>
									<Button type="submit" size="sm" disabled={busy || !value.trim() || value.trim().toLowerCase() === saved.hostname}>
										{t("domains.tracking.save")}
									</Button>
									{saved.hostname && (
										<Button type="button" size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => void save(null)}>
											{t("domains.tracking.remove")}
										</Button>
									)}
								</form>
								<p className={failed ? "text-xs text-amber-700" : "text-xs text-neutral-500"}>{status}</p>
							</div>
						) : (
							t("domains.tracking.migrationRequired")
						)}
					</div>
				</li>
			</ul>
			{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
		</section>
	);
}
