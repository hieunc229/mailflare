"use client";

import { useEffect } from "react";
import { AlertTriangle } from "@/components/icons";
import { useCurrentUser } from "@/hooks/use-current-user";

/**
 * Hosted workspace whose free trial is over and that never subscribed: an upgrade bar on top of every page. The same flag
 * turns on the blur of inbound mail (globals.css, `data-lock-blur`); the server refuses sending and adding things.
 */
export function TrialExpiredBanner() {
	const user = useCurrentUser();
	const expired = !!user?.trialExpired;
	useEffect(() => {
		if (!expired) return;
		document.documentElement.dataset.trialExpired = "";
		return () => { delete document.documentElement.dataset.trialExpired; };
	}, [expired]);
	if (!expired) return null;
	return (
		<div role="alert" className="mx-2 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-900">
			<AlertTriangle className="h-4 w-4 shrink-0" />
			<p className="min-w-0 flex-1">Your free trial has ended. Incoming mail is blurred, and sending, adding domains, users and mailboxes are turned off until you upgrade.</p>
			{user?.upgradeUrl
				? <a href={user.upgradeUrl} className="shrink-0 rounded-full bg-red-600 px-4 py-1.5 font-semibold text-white hover:bg-red-700">Upgrade</a>
				: <span className="shrink-0 font-semibold">Ask the workspace owner to upgrade.</span>}
		</div>
	);
}
