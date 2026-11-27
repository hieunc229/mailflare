"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "@/components/icons";
import { authFetch } from "@/lib/auth/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";

type SkippedDomain = { id: string; hostname: string; dnsSkipped?: boolean };

async function fetchSkippedDomains(): Promise<SkippedDomain[] | null> {
	try {
		const res = await authFetch("/api/domains", { redirectOnUnauthorized: false });
		if (!res.ok) return null;
		const data = (await res.json()) as { domains?: SkippedDomain[] };
		return (data.domains ?? []).filter((domain) => domain.dnsSkipped);
	} catch {
		// The banner is advisory; a failed read just hides it.
		return null;
	}
}

/** Clears the flag on domains whose DNS is now in place and returns the rest. */
async function dropPublishedDomains(domains: SkippedDomain[]): Promise<SkippedDomain[]> {
	const published = await Promise.all(
		domains.map(async (domain) => {
			try {
				const res = await authFetch(`/api/domains/${domain.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ dnsSkipped: false, verify: true }),
				});
				if (!res.ok) return false;
				return ((await res.json()) as { verified?: boolean }).verified !== false;
			} catch {
				return false;
			}
		}),
	);
	return domains.filter((_, index) => !published[index]);
}

export function DnsSkippedBanner() {
	const { t } = useLanguage();
	const user = useCurrentUser();
	const [domains, setDomains] = useState<SkippedDomain[]>([]);
	const [busy, setBusy] = useState(false);

	const canManage = !!user && (user.isPrimaryAdmin || (user.role === "admin" && user.canManageDomains));

	const load = useCallback(async () => {
		const next = await fetchSkippedDomains();
		if (next) setDomains(next);
	}, []);

	// Nothing is shown until DNS has been checked, so a configured domain never flashes the warning.
	useEffect(() => {
		if (!user) return;
		let active = true;
		void fetchSkippedDomains().then(async (next) => {
			if (!next) return;
			const pending = canManage ? await dropPublishedDomains(next) : next;
			if (active) setDomains(pending);
		});
		return () => {
			active = false;
		};
	}, [user, canManage]);

	if (domains.length === 0) return null;

	async function markDone() {
		setBusy(true);
		try {
			await Promise.all(
				domains.map((domain) =>
					authFetch(`/api/domains/${domain.id}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ dnsSkipped: false }),
					}),
				),
			);
		} finally {
			setBusy(false);
			await load();
		}
	}

	return (
		<div role="status" className="mx-2 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
			<AlertTriangle className="h-4 w-4 shrink-0" />
			<p className="min-w-0 flex-1">{t("dnsSkipped.warning", { domains: domains.map((domain) => domain.hostname).join(", ") })}</p>
			{canManage && (
				<>
					<Link href="/domains" className="font-semibold underline underline-offset-2">{t("dnsSkipped.review")}</Link>
					<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void markDone()}>{t("dnsSkipped.markDone")}</Button>
				</>
			)}
		</div>
	);
}
