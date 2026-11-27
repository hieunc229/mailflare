"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { runReceivingSetup } from "./api";
import { StatusRow } from "./status-row";

type Props = {
	domainId: string;
	routingOk: boolean;
	routingLabel: string;
	manual: boolean;
	onChanged?: () => void;
};

/** Email Routing status for the zone, with a setup that also deals with conflicting MX records. */
export default function CloudflareReceivingConfig({ domainId, routingOk, routingLabel, manual, onChanged }: Props) {
	const { t } = useLanguage();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	async function setup() {
		setBusy(true);
		setError("");
		try {
			if (await runReceivingSetup(domainId, "cloudflare")) onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : t("domains.setupFailed"));
		} finally { setBusy(false); }
	}

	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				<StatusRow
					ok={routingOk}
					title={t("domains.emailRouting")}
					hint={t("domains.emailRoutingHint")}
					action={!routingOk && !manual ? (
						<Button size="sm" variant="outline" className="bg-white" disabled={busy} onClick={() => void setup()}>
							{busy ? t("domains.settingUp") : t("domains.setup")}
						</Button>
					) : undefined}
				>
					{routingLabel}
				</StatusRow>
			</ul>
			{error && <p role="alert" className="text-xs text-red-600">{error}</p>}
		</div>
	);
}
