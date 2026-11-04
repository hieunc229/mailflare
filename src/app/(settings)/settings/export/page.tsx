"use client";

import { useState } from "react";
import { Download } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { useSelectedMailbox } from "@/components/mailbox-provider";
import { Button } from "@/components/ui/button";
import type { ExportState } from "./types";
import { exportMailbox } from "./utils";

export default function SettingsExportPage() {
	const { t } = useLanguage();
	const { selectedMailbox } = useSelectedMailbox();
	const [exportState, setExportState] = useState<ExportState>({ error: null, loading: false });

	async function onExport() {
		if (!selectedMailbox?.id) return;
		setExportState({ error: null, loading: true });
		try {
			await exportMailbox(selectedMailbox.id, `${selectedMailbox.localPart}.mbox`);
		} catch (error) {
			setExportState({ error: error instanceof Error ? error.message : t("export.failed"), loading: false });
			return;
		}
		setExportState({ error: null, loading: false });
	}

	return (
		<div className="space-y-6">
			<h1 className="sr-only">{t("settings.nav.export")}</h1>
			{/* <div>
				<h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Export</h1>
				<p className="mt-1 text-sm text-neutral-500">
					Download mail from the currently selected mailbox.
				</p>
			</div> */}

			<section className="space-y-4">
				<div>
					<h2 className="text-xl font-semibold text-neutral-900">{t("export.title")}</h2>
					<p className="mt-1 text-sm text-neutral-500">
						{t("export.description")}
					</p>
				</div>
				<div className="space-y-3 rounded-3xl bg-white p-6">
					<Button type="button" variant="outline" disabled={!selectedMailbox || exportState.loading} onClick={onExport}>
						{exportState.loading ? t("export.preparing") : t("export.download")}
					</Button>
					{exportState.error && (
						<p className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">
							{exportState.error}
						</p>
					)}
				</div>
			</section>
		</div>
	);
}
