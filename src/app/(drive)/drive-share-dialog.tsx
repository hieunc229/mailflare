"use client";

import { useCallback, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Copy, Link2, X } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { authFetch } from "@/lib/auth/client";
import type { DriveItemDto, DriveShareDto, DriveShareRole } from "@/lib/drive/types";

const selectClass = "h-10 rounded-md border border-neutral-200 bg-white px-2 text-sm";

export function DriveShareDialog({ item, onClose, onChanged }: { item: DriveItemDto | null; onClose: () => void; onChanged: () => void }) {
	const { t } = useLanguage();
	const [shares, setShares] = useState<DriveShareDto[]>([]);
	const [linkToken, setLinkToken] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<DriveShareRole>("view");
	const [busy, setBusy] = useState(false);
	const id = item?.id;

	const load = useCallback(async () => {
		if (!id) return;
		const response = await authFetch(`/api/drive/items/${id}/shares`);
		if (!response.ok) return toast.error(t("drive.shareFailed"));
		const data = await response.json() as { shares: DriveShareDto[]; linkToken: string | null };
		setShares(data.shares);
		setLinkToken(data.linkToken);
	}, [id, t]);

	useEffect(() => {
		setShares([]); setLinkToken(null); setEmail("");
		void load();
	}, [load]);

	async function request(input: string, init: RequestInit) {
		setBusy(true);
		try {
			const response = await authFetch(input, init);
			const data = await response.json().catch(() => ({})) as { shares?: DriveShareDto[]; linkToken?: string | null; error?: string };
			if (!response.ok) { toast.error(data.error ?? t("drive.shareFailed")); return null; }
			onChanged();
			return data;
		} finally { setBusy(false); }
	}

	async function addPerson(event: React.FormEvent) {
		event.preventDefault();
		if (!item || !email.trim()) return;
		const data = await request(`/api/drive/items/${item.id}/shares`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, role }) });
		if (data?.shares) { setShares(data.shares); setEmail(""); }
	}

	async function removePerson(shareId: string) {
		if (!item) return;
		const data = await request(`/api/drive/items/${item.id}/shares?shareId=${encodeURIComponent(shareId)}`, { method: "DELETE" });
		if (data?.shares) setShares(data.shares);
	}

	async function toggleLink() {
		if (!item) return;
		const data = await request(`/api/drive/items/${item.id}/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !linkToken }) });
		if (data) setLinkToken(data.linkToken ?? null);
	}

	const linkUrl = linkToken ? `${window.location.origin}/d/${linkToken}` : "";

	return (
		<Dialog open={!!item} onOpenChange={(open) => { if (!open) onClose(); }}>
			<DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto">
				<DialogHeader><DialogTitle className="pr-6 truncate">{t("drive.shareTitle", { name: item?.name ?? "" })}</DialogTitle></DialogHeader>
				<form onSubmit={addPerson} className="flex gap-2">
					<Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("drive.shareEmail")} aria-label={t("drive.shareEmail")} />
					<select value={role} onChange={(event) => setRole(event.target.value as DriveShareRole)} className={selectClass} aria-label={t("drive.peopleWithAccess")}>
						<option value="view">{t("drive.canView")}</option>
						<option value="edit">{t("drive.canEdit")}</option>
					</select>
					<Button type="submit" disabled={busy || !email.trim()}>{t("drive.shareAdd")}</Button>
				</form>
				<h3 className="mb-2 mt-6 text-sm font-medium text-neutral-900">{t("drive.peopleWithAccess")}</h3>
				{shares.length === 0 ? <p className="text-sm text-neutral-500">{t("drive.noPeople")}</p> : (
					<ul className="space-y-1">
						{shares.map((share) => (
							<li key={share.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-neutral-50">
								<span className="min-w-0 flex-1"><span className="block truncate text-neutral-900">{share.name}</span><span className="block truncate text-xs text-neutral-500">{share.email}</span></span>
								<span className="shrink-0 text-xs text-neutral-500">{share.role === "edit" ? t("drive.canEdit") : t("drive.canView")}</span>
								<button type="button" onClick={() => void removePerson(share.id)} disabled={busy} aria-label={t("drive.remove")} className="rounded-full p-1 text-neutral-500 hover:bg-neutral-200"><X size={14} /></button>
							</li>
						))}
					</ul>
				)}
				<h3 className="mb-2 mt-6 text-sm font-medium text-neutral-900">{t("drive.generalAccess")}</h3>
				<div className="flex items-center gap-3 rounded-lg border border-neutral-200 p-3 text-sm">
					<Link2 size={18} className="shrink-0 text-neutral-500" />
					<span className="min-w-0 flex-1 text-neutral-700">{linkToken ? t("drive.linkOn") : t("drive.linkOff")}</span>
					<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void toggleLink()}>{linkToken ? t("drive.linkDisable") : t("drive.linkEnable")}</Button>
				</div>
				{linkToken && (
					<div className="mt-2 flex gap-2">
						<Input readOnly value={linkUrl} onFocus={(event) => event.currentTarget.select()} aria-label={t("drive.copyLink")} />
						<Button type="button" variant="outline" onClick={() => { void navigator.clipboard.writeText(linkUrl).then(() => toast.success(t("drive.linkCopied"))); }}><Copy size={16} />{t("drive.copyLink")}</Button>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
