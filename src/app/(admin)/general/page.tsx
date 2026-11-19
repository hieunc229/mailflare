"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { MAX_SHARED_FILES_NOTICE_LENGTH } from "@/lib/email/attachment-limits";
import { loadGeneralSettings, saveGeneralSettings } from "./utils";

export default function GeneralSettingsPage() {
	const { t } = useLanguage();
	const [maxMb, setMaxMb] = useState(25);
	const [ceilingMb, setCeilingMb] = useState(25);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState("");
	const [customNotice, setCustomNotice] = useState(false);
	const [notice, setNotice] = useState("");
	const [noticeSaving, setNoticeSaving] = useState(false);
	const [noticeStatus, setNoticeStatus] = useState("");
	const [unlimited, setUnlimited] = useState(true);
	const [limitGb, setLimitGb] = useState(10);
	const [driveSaving, setDriveSaving] = useState(false);
	const [driveStatus, setDriveStatus] = useState("");

	useEffect(() => {
		let active = true;
		void loadGeneralSettings().then((settings) => {
			if (active) { setMaxMb(settings.outboundAttachmentMaxMb); setCeilingMb(settings.outboundAttachmentCeilingMb); setCustomNotice(settings.sharedFilesNotice !== null); setNotice(settings.sharedFilesNotice ?? ""); setUnlimited(settings.driveStorageLimitGb === null); if (settings.driveStorageLimitGb !== null) setLimitGb(settings.driveStorageLimitGb); setLoaded(true); }
		}).catch((error) => { if (active) setStatus(error instanceof Error ? error.message : t("general.loadFailed")); });
		return () => { active = false; };
	}, [t]);

	async function save(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSaving(true);
		setStatus("");
		try {
			const settings = await saveGeneralSettings({ outboundAttachmentMaxMb: maxMb });
			setMaxMb(settings.outboundAttachmentMaxMb);
			setStatus(t("general.saved"));
		} catch (error) {
			setStatus(error instanceof Error ? error.message : t("general.saveFailed"));
		} finally { setSaving(false); }
	}

	async function saveNotice(next: string | null) {
		setNoticeSaving(true);
		setNoticeStatus("");
		try {
			const settings = await saveGeneralSettings({ sharedFilesNotice: next });
			setCustomNotice(settings.sharedFilesNotice !== null);
			setNotice(settings.sharedFilesNotice ?? "");
			setNoticeStatus(t("general.noticeSaved"));
		} catch (error) {
			setNoticeStatus(error instanceof Error ? error.message : t("general.saveFailed"));
		} finally { setNoticeSaving(false); }
	}

	async function saveDrive(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setDriveSaving(true);
		setDriveStatus("");
		try {
			const settings = await saveGeneralSettings({ driveStorageLimitGb: unlimited ? null : limitGb });
			setUnlimited(settings.driveStorageLimitGb === null);
			if (settings.driveStorageLimitGb !== null) setLimitGb(settings.driveStorageLimitGb);
			setDriveStatus(t("general.driveSaved"));
		} catch (error) {
			setDriveStatus(error instanceof Error ? error.message : t("general.saveFailed"));
		} finally { setDriveSaving(false); }
	}

	return <div className="space-y-6">
		<div><h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("general.title")}</h1><p className="mt-2 text-sm text-neutral-500">{t("general.description")}</p></div>
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("general.attachments")}</CardTitle></CardHeader>
			<CardContent className="pt-6"><form onSubmit={save} className="space-y-4">
				<div className="space-y-2"><Label htmlFor="attachment-limit">{t("general.maxAttachments")}</Label><Input id="attachment-limit" type="number" min="1" max={ceilingMb} step="1" value={maxMb} onChange={(event) => setMaxMb(Number(event.target.value))} disabled={!loaded || saving} className="max-w-40" required /><p className="text-sm text-neutral-500">{t("general.appliesToMax", { max: ceilingMb })}</p></div>
				<div className="space-y-2 rounded-xl bg-neutral-50 p-4 text-sm text-neutral-700"><p>{t("general.cloudflareLimit")}</p><p>{t("general.largeFiles")}</p><p>{t("general.largeFilesOthers")}</p></div>
				{status && <p role="status" className="text-sm text-neutral-700">{status}</p>}
				<Button type="submit" disabled={!loaded || saving || !Number.isInteger(maxMb) || maxMb < 1 || maxMb > ceilingMb}>{saving ? t("common.saving") : t("general.save")}</Button>
			</form></CardContent>
		</Card>
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("general.noticeTitle")}</CardTitle></CardHeader>
			<CardContent className="pt-6"><form onSubmit={(event) => { event.preventDefault(); void saveNotice(customNotice ? notice : null); }} className="space-y-4">
				<div className="flex items-center gap-3"><Switch id="notice-custom" checked={customNotice} onCheckedChange={setCustomNotice} disabled={!loaded || noticeSaving} /><Label htmlFor="notice-custom">{t("general.noticeCustom")}</Label></div>
				{customNotice && <div className="space-y-2"><Label htmlFor="notice-text">{t("general.noticeText")}</Label><Textarea id="notice-text" rows={3} maxLength={MAX_SHARED_FILES_NOTICE_LENGTH} value={notice} onChange={(event) => setNotice(event.target.value)} disabled={!loaded || noticeSaving} /></div>}
				<p className="text-sm text-neutral-500">{t("general.noticeHint")}</p>
				{noticeStatus && <p role="status" className="text-sm text-neutral-700">{noticeStatus}</p>}
				<div className="flex gap-2"><Button type="submit" disabled={!loaded || noticeSaving}>{noticeSaving ? t("common.saving") : t("general.save")}</Button>{customNotice && <Button type="button" variant="outline" disabled={!loaded || noticeSaving} onClick={() => void saveNotice(null)}>{t("general.noticeReset")}</Button>}</div>
			</form></CardContent>
		</Card>
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("general.drive")}</CardTitle></CardHeader>
			<CardContent className="pt-6"><form onSubmit={saveDrive} className="space-y-4">
				<div className="flex items-center gap-3"><Switch id="drive-unlimited" checked={unlimited} onCheckedChange={setUnlimited} disabled={!loaded || driveSaving} /><Label htmlFor="drive-unlimited">{t("general.driveUnlimited")}</Label></div>
				{!unlimited && <div className="space-y-2"><Label htmlFor="drive-limit">{t("general.driveLimit")}</Label><Input id="drive-limit" type="number" min="0.01" max="1000000" step="any" value={limitGb} onChange={(event) => setLimitGb(Number(event.target.value))} disabled={!loaded || driveSaving} className="max-w-40" required /></div>}
				<p className="text-sm text-neutral-500">{t("general.driveHint")}</p>
				{driveStatus && <p role="status" className="text-sm text-neutral-700">{driveStatus}</p>}
				<Button type="submit" disabled={!loaded || driveSaving || (!unlimited && !(limitGb > 0))}>{driveSaving ? t("common.saving") : t("general.save")}</Button>
			</form></CardContent>
		</Card>
	</div>;
}
