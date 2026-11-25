"use client";

import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/hooks/use-current-user";
import { scanTakeoutData } from "@/lib/import/takeout-data-utils";
import type { TakeoutScan } from "@/lib/import/takeout-data-types";
import { isZipSupported } from "@/lib/import/zip-utils";
import { TakeoutCalendarCard } from "./takeout-calendar-card";
import { TakeoutContactsCard } from "./takeout-contacts-card";
import { TakeoutDriveCard } from "./takeout-drive-card";

/** Import Google Calendar, Contacts and Drive from a Takeout export. The files are read in the browser; only parsed events and contacts, and the Drive files themselves, are uploaded. */
export function TakeoutDataImport() {
	const { t } = useLanguage();
	// The server answers 403 when an admin switched Calendar off; say so up front instead of after a scan.
	const user = useCurrentUser();
	const calendarOff = user?.calendarEnabled === false;
	const driveOff = user?.driveEnabled === false;
	const hasDrive = (scan: TakeoutScan) => scan.drive.files.length > 0;
	const [scan, setScan] = useState<TakeoutScan | null>(null);
	const [scanning, setScanning] = useState(false);
	const [scanId, setScanId] = useState(0);
	const [error, setError] = useState<string | null>(null);

	async function onFiles(files: File[]) {
		setScan(null);
		setError(null);
		if (files.length === 0) return;
		if (!isZipSupported() && files.some((file) => /\.zip$/i.test(file.name))) {
			setError(t("importPage.takeoutDataUnsupported"));
			return;
		}
		setScanning(true);
		try {
			setScan(await scanTakeoutData(files));
			setScanId((id) => id + 1);
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : String(caught));
		} finally {
			setScanning(false);
		}
	}

	const notice = (key: Parameters<typeof t>[0], files: string[]) => files.length > 0 && (
		<p className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t(key, { files: files.join(", ") })}</p>
	);

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<Label htmlFor="takeout-data-files">{t("importPage.takeoutFiles")}</Label>
				<Input
					id="takeout-data-files"
					type="file"
					accept=".zip,.ics,.vcf,.csv,application/zip,text/calendar,text/vcard,text/csv"
					multiple
					onChange={(event) => void onFiles(Array.from(event.target.files ?? []))}
					className="block w-full rounded-md border border-neutral-200 bg-white px-3 py-1 text-sm shadow-sm shadow-neutral-200/50 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm file:font-medium"
				/>
				<p className="text-xs leading-5 text-neutral-500">{t("importPage.takeoutDataHint")}</p>
			</div>
			{calendarOff && (!scan || scan.calendars.length > 0) && <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.takeoutDataCalendarOff")}</p>}
			{driveOff && (!scan || hasDrive(scan)) && <p role="status" className="rounded-lg border border-amber-100 bg-amber-50 px-4 py-3 text-sm text-amber-700">{t("importPage.takeoutDriveOff")}</p>}
			{scanning && <p className="text-xs text-neutral-500" aria-live="polite">{t("importPage.preparing")}</p>}
			{scan && (
				<>
					{notice("importPage.takeoutDataTooLarge", scan.tooLarge)}
					{notice("importPage.takeoutDataUnreadable", scan.unreadable)}
					{notice("importPage.takeoutDataIgnored", scan.ignored)}
					{scan.calendars.length > 0 && !calendarOff && <TakeoutCalendarCard key={`calendar-${scanId}`} sources={scan.calendars} />}
					{scan.contacts.length > 0 && <TakeoutContactsCard key={`contacts-${scanId}`} sources={scan.contacts} />}
					{hasDrive(scan) && !driveOff && <TakeoutDriveCard key={`drive-${scanId}`} drive={scan.drive} />}
					{scan.calendars.length === 0 && scan.contacts.length === 0 && !hasDrive(scan) && <p className="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">{t("importPage.takeoutDataNothing")}</p>}
				</>
			)}
			{error && <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
		</div>
	);
}
