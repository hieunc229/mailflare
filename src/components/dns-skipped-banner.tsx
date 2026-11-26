"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "@/components/icons";
import { authFetch } from "@/lib/auth/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useLanguage } from "@/components/language-provider";

type SkippedDomain = { id: string; hostname: string; dnsSkipped?: boolean };

/** Fired by the Domains page after a DNS check so the banner re-reads right away. */
export const DNS_CHECKED_EVENT = "mailflare:dns-checked";

async function fetchSkippedDomains(): Promise<SkippedDomain[] | null> {
	try {
		const res = await authFetch("/api/domains", { redirectOnUnauthorized: false });
		if (!res.ok) return null;
		const data = (await res.json()) as { domains?: SkippedDomain[] };
		return (data.domains ?? []).filter((domain) => domain.dnsSkipped);
	} catch {
		// The banner is advisory; a failed read just leaves it as is.
		return null;
	}
}

// The flag is cleared server-side once every DNS record verifies, so the banner only reads it (no manual "mark done").
export function DnsSkippedBanner() {
	const { t } = useLanguage();
	const user = useCurrentUser();
	const pathname = usePathname();
	const [domains, setDomains] = useState<SkippedDomain[]>([]);

	const load = useCallback(async () => {
		const next = await fetchSkippedDomains();
		if (next) setDomains(next);
	}, []);

	useEffect(() => {
		void load();
	}, [load, pathname]);

	useEffect(() => {
		window.addEventListener(DNS_CHECKED_EVENT, load);
		window.addEventListener("focus", load);
		return () => {
			window.removeEventListener(DNS_CHECKED_EVENT, load);
			window.removeEventListener("focus", load);
		};
	}, [load]);

	if (domains.length === 0) return null;
	const canManage = !!user && (user.isPrimaryAdmin || (user.role === "admin" && user.canManageDomains));

	return (
		<div role="status" className="mx-2 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
			<AlertTriangle className="h-4 w-4 shrink-0" />
			<p className="min-w-0 flex-1">{t("dnsSkipped.warning", { domains: domains.map((domain) => domain.hostname).join(", ") })}</p>
			{canManage && <Link href="/domains" className="font-semibold underline underline-offset-2">{t("dnsSkipped.review")}</Link>}
		</div>
	);
}
