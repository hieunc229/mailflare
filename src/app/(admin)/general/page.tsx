"use client";

import { useEffect, useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { locales } from "@/lib/i18n/locales";
import { SHARED_NOTICE_MAX_LENGTH } from "@/lib/email/shared-file-notice";
import { loadGeneralSettings, saveGeneralSettings } from "./utils";

export default function GeneralSettingsPage() {
	const { t } = useLanguage();
	const [maxMb, setMaxMb] = useState(25);
	const [ceilingMb, setCeilingMb] = useState(25);
	const [loaded, setLoaded] = useState(false);
	const [saving, setSaving] = useState(false);
	const [status, setStatus] = useState("");
	const [unlimited, setUnlimited] = useState(true);
	const [limitGb, setLimitGb] = useState(10);
	const [driveSaving, setDriveSaving] = useState(false);
	const [driveStatus, setDriveStatus] = useState("");
	const [sharedFilesNoticeEnabled, setSharedFilesNoticeEnabled] = useState(true);
	const [sharedFilesNoticeText, setSharedFilesNoticeText] = useState("");
	const [sharedFilesLinkDays, setSharedFilesLinkDays] = useState(30);
	const [sharedFilesNoticeLocale, setSharedFilesNoticeLocale] = useState<string | null>(null);
	const [sharedFilesCardStyle, setSharedFilesCardStyle] = useState<"card" | "links">("card");
	const [sharedSaving, setSharedSaving] = useState(false);
	const [sharedStatus, setSharedStatus] = useState("");

	useEffect(() => {
		let active = true;
		void loadGeneralSettings().then((settings) => {
			if (active) {
				setMaxMb(settings.outboundAttachmentMaxMb);
				setCeilingMb(settings.outboundAttachmentCeilingMb);
				setUnlimited(settings.driveStorageLimitGb === null);
				if (settings.driveStorageLimitGb !== null) setLimitGb(settings.driveStorageLimitGb);
				setSharedFilesNoticeEnabled(settings.sharedFilesNoticeEnabled ?? true);
				setSharedFilesNoticeText(settings.sharedFilesNoticeText ?? "");
				setSharedFilesLinkDays(settings.sharedFilesLinkDays ?? 30);
				setSharedFilesNoticeLocale(settings.sharedFilesNoticeLocale ?? null);
				setSharedFilesCardStyle(settings.sharedFilesCardStyle === "links" ? "links" : "card");
				setLoaded(true);
			}
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
			setStatus(error instanceof Error ? error.message : t("general.saveFailed"));
		} finally { setDriveSaving(false); }
	}

	async function saveSharedFiles(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSharedSaving(true);
		setSharedStatus("");
		try {
			await saveGeneralSettings({
				sharedFilesNoticeEnabled,
				sharedFilesNoticeText,
				sharedFilesLinkDays,
				sharedFilesNoticeLocale: sharedFilesNoticeLocale || null,
				sharedFilesCardStyle,
			});
			setSharedStatus(t("general.saved"));
		} catch (error) {
			setSharedStatus(error instanceof Error ? error.message : t("general.saveFailed"));
		} finally { setSharedSaving(false); }
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
			<CardHeader className="py-0"><CardTitle>{t("general.drive")}</CardTitle></CardHeader>
			<CardContent className="pt-6"><form onSubmit={saveDrive} className="space-y-4">
				<div className="flex items-center gap-3"><Switch id="drive-unlimited" checked={unlimited} onCheckedChange={setUnlimited} disabled={!loaded || driveSaving} /><Label htmlFor="drive-unlimited">{t("general.driveUnlimited")}</Label></div>
				{!unlimited && <div className="space-y-2"><Label htmlFor="drive-limit">{t("general.driveLimit")}</Label><Input id="drive-limit" type="number" min="0.01" max="1000000" step="any" value={limitGb} onChange={(event) => setLimitGb(Number(event.target.value))} disabled={!loaded || driveSaving} className="max-w-40" required /></div>}
				<p className="text-sm text-neutral-500">{t("general.driveHint")}</p>
				{driveStatus && <p role="status" className="text-sm text-neutral-700">{driveStatus}</p>}
				<Button type="submit" disabled={!loaded || driveSaving || (!unlimited && !(limitGb > 0))}>{driveSaving ? t("common.saving") : t("general.save")}</Button>
			</form></CardContent>
		</Card>
		<Card className="rounded-3xl border-0 bg-white p-6">
			<CardHeader className="py-0"><CardTitle>{t("general.sharedFiles")}</CardTitle></CardHeader>
			<CardContent className="pt-6"><form onSubmit={saveSharedFiles} className="space-y-4">
				<p className="text-sm text-neutral-500">{t("general.sharedFilesDescribe")}</p>
				<div className="flex items-center gap-3"><Switch id="shared-files-enable" checked={sharedFilesNoticeEnabled} onCheckedChange={(value) => setSharedFilesNoticeEnabled(value)} disabled={!loaded || sharedSaving} /><Label htmlFor="shared-files-enable">{t("general.sharedFilesEnable")}</Label></div>
				<div className="space-y-2"><Label htmlFor="shared-files-text">{t("general.sharedFilesText")}</Label><Textarea id="shared-files-text" value={sharedFilesNoticeText} onChange={(event) => setSharedFilesNoticeText(event.target.value)} maxLength={SHARED_NOTICE_MAX_LENGTH} rows={2} disabled={!loaded || sharedSaving} placeholder={t("general.sharedFilesTextPlaceholder")} /><p className="text-sm text-neutral-500">{t("general.sharedFilesTextHint", { max: SHARED_NOTICE_MAX_LENGTH })}</p></div>
				<div className="space-y-2"><Label htmlFor="shared-files-days">{t("general.sharedFilesDays")}</Label><Input id="shared-files-days" type="number" min="1" max="365" step="1" value={sharedFilesLinkDays} onChange={(event) => setSharedFilesLinkDays(Number(event.target.value))} disabled={!loaded || sharedSaving} className="max-w-40" required /><p className="text-sm text-neutral-500">{t("general.sharedFilesDaysHint")}</p></div>
				<div className="space-y-2"><Label htmlFor="shared-files-locale">{t("general.sharedFilesLocale")}</Label><select id="shared-files-locale" value={sharedFilesNoticeLocale ?? ""} onChange={(event) => setSharedFilesNoticeLocale(event.target.value === "" ? null : event.target.value)} disabled={!loaded || sharedSaving} className="h-9 w-full max-w-64 rounded-md border border-neutral-200 bg-white px-3 text-sm"><option value="">{t("general.sharedFilesLocaleAuto")}</option>{Object.entries(locales).map(([code, entry]) => <option key={code} value={code}>{entry.label}</option>)}</select></div>
				<div className="space-y-2"><Label htmlFor="shared-files-style">{t("general.sharedFilesStyle")}</Label><select id="shared-files-style" value={sharedFilesCardStyle} onChange={(event) => setSharedFilesCardStyle(event.target.value === "links" ? "links" : "card")} disabled={!loaded || sharedSaving} className="h-9 w-full max-w-64 rounded-md border border-neutral-200 bg-white px-3 text-sm"><option value="card">{t("general.sharedFilesStyleCard")}</option><option value="links">{t("general.sharedFilesStyleLinks")}</option></select></div>
				{sharedStatus && <p role="status" className="text-sm text-neutral-700">{sharedStatus}</p>}
				<Button type="submit" disabled={!loaded || sharedSaving || !Number.isInteger(sharedFilesLinkDays) || sharedFilesLinkDays < 1 || sharedFilesLinkDays > 365}>{sharedSaving ? t("common.saving") : t("general.save")}</Button>
			</form></CardContent>
		</Card>
	</div>;
}