"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "@/components/icons";
import { authFetch } from "@/lib/auth/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";

type CheckedDomain = { id: string; hostname: string; dnsSkipped?: boolean; dnsReady?: boolean | null };

async function fetchCheckedDomains(): Promise<CheckedDomain[] | null> {
	try {
		const res = await authFetch("/api/domains?dnsStatus=true", { redirectOnUnauthorized: false });
		if (!res.ok) return null;
		return ((await res.json()) as { domains?: CheckedDomain[] }).domains ?? [];
	} catch {
		// The banner is advisory; a failed read just hides it.
		return null;
	}
}

/** A failed lookup says nothing, so only a domain added with DNS skipped is still warned about then. */
const needsDns = (domain: CheckedDomain) => domain.dnsReady === false || (domain.dnsReady !== true && !!domain.dnsSkipped);

function patchDomain(id: string, body: { dnsSkipped: false; verify?: boolean }) {
	return authFetch(`/api/domains/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

export function DnsSkippedBanner() {
	const { t } = useLanguage();
	const user = useCurrentUser();
	const [domains, setDomains] = useState<CheckedDomain[]>([]);
	const [busy, setBusy] = useState(false);
	const canManage = !!user && (user.isPrimaryAdmin || (user.role === "admin" && user.canManageDomains));

	const load = useCallback(async () => {
		const next = await fetchCheckedDomains();
		if (!next) return;
		// A domain added with DNS skipped becomes active once its DNS is in place.
		if (canManage) {
			await Promise.allSettled(
				next.filter((domain) => domain.dnsSkipped && domain.dnsReady === true).map((domain) => patchDomain(domain.id, { dnsSkipped: false })),
			);
		}
		setDomains(next.filter(needsDns));
	}, [canManage]);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the request resolves
		if (user) void load();
	}, [user, load]);

	if (domains.length === 0) return null;

	/** `verify` looks DNS up again; without it the operator's word is taken. */
	async function update(verify: boolean) {
		setBusy(true);
		try {
			await Promise.all(domains.map((domain) => patchDomain(domain.id, { dnsSkipped: false, verify })));
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
					<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void update(true)}>{t("dnsSkipped.recheck")}</Button>
					<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void update(false)}>{t("dnsSkipped.markDone")}</Button>
				</>
			)}
		</div>
	);
}
