"use client";

import { use, useEffect, useState } from "react";
import { ChevronRight, Download } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { formatDriveSize } from "@/lib/drive/utils";
import { DrivePreviewBody } from "@/app/(drive)/drive-preview";
import { driveIconFor, publicContentUrl, sortDriveItems } from "@/app/(drive)/drive-utils";
import type { PublicDriveItem, PublicDriveListing } from "./types";

export default function PublicDrivePage({ params }: { params: Promise<{ token: string }> }) {
	const { token } = use(params);
	const { t } = useLanguage();
	const [itemId, setItemId] = useState<string | null>(null);
	const [data, setData] = useState<PublicDriveListing | null>(null);
	const [missing, setMissing] = useState(false);

	useEffect(() => {
		let active = true;
		const search = itemId ? `?item=${encodeURIComponent(itemId)}` : "";
		void fetch(`/api/drive/public/${encodeURIComponent(token)}${search}`)
			.then(async (response) => {
				if (!response.ok) throw new Error();
				return response.json() as Promise<PublicDriveListing>;
			})
			.then((listing) => { if (active) { setData(listing); setMissing(false); } })
			.catch(() => { if (active) setMissing(true); });
		return () => { active = false; };
	}, [token, itemId]);

	if (missing) return <main className="flex min-h-dvh items-center justify-center bg-[#f6f8fc] p-6 text-center text-neutral-600">{t("drive.publicNotFound")}</main>;
	if (!data) return <main className="min-h-dvh bg-[#f6f8fc]" aria-busy="true" />;
	const { item, items, path } = data;
	const isFile = item.kind === "file";

	return (
		<main className="mx-auto flex min-h-dvh max-w-5xl flex-col bg-[#f6f8fc] p-4 md:p-8">
			<nav className="mb-4 flex flex-wrap items-center gap-1 text-lg text-neutral-800">
				{path.map((crumb, index) => (
					<span key={crumb.id} className="flex items-center gap-1">
						{index > 0 && <ChevronRight size={18} className="text-neutral-500" />}
						{index === path.length - 1 ? <h1 className="px-2 py-1">{crumb.name}</h1> : <button type="button" onClick={() => setItemId(crumb.id)} className="rounded-full px-2 py-1 hover:bg-neutral-200/60">{crumb.name}</button>}
					</span>
				))}
				{isFile && <a href={publicContentUrl(token, item.id, true)} className="ml-auto inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"><Download size={16} />{t("drive.download")}</a>}
			</nav>
			{isFile ? (
				<div className="min-h-[70vh] flex-1 rounded-2xl bg-[#202124] p-3"><DrivePreviewBody src={publicContentUrl(token, item.id)} downloadHref={publicContentUrl(token, item.id, true)} contentType={item.contentType} name={item.name} /></div>
			) : (
				<div className="rounded-2xl bg-white p-2">
					{items.length === 0 ? <p className="p-10 text-center text-sm text-neutral-500">{t("drive.empty")}</p> : sortDriveItems(items, "name", true).map((entry) => <PublicRow key={entry.id} entry={entry} token={token} onOpen={setItemId} />)}
				</div>
			)}
		</main>
	);
}

function PublicRow({ entry, token, onOpen }: { entry: PublicDriveItem; token: string; onOpen: (id: string) => void }) {
	const { Icon, className } = driveIconFor(entry);
	return (
		<div className="flex items-center gap-4 rounded-lg px-3 text-sm hover:bg-neutral-50">
			<button type="button" onClick={() => onOpen(entry.id)} className="flex min-w-0 flex-1 items-center gap-4 py-3 text-left">
				<Icon size={16} className={className} fill={entry.kind === "folder" ? "currentColor" : "none"} />
				<span className="truncate text-neutral-900">{entry.name}</span>
			</button>
			{entry.kind === "file" && <span className="hidden shrink-0 text-neutral-500 sm:block">{formatDriveSize(entry.size)}</span>}
			{entry.kind === "file" && <a href={publicContentUrl(token, entry.id, true)} aria-label={entry.name} className="shrink-0 rounded-full p-2 text-neutral-600 hover:bg-neutral-200"><Download size={16} /></a>}
		</div>
	);
}
