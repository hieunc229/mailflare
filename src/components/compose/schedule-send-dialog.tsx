"use client";

import { ArrowLeft, BriefcaseBusiness, CalendarDays, Sun } from "lucide-react";
import { AfternoonSunIcon } from "@/components/icons/scheduled-send-icon";
import { useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { TranslationKey } from "@/lib/i18n/types";
import {
	formatDateTimeLocal,
	formatQuickScheduleParts,
	getQuickScheduleOptions,
	getTimeZoneLongName,
	isSchedulableTime,
	parseDateTimeLocal,
} from "./schedule-send-utils";
import type { ScheduleQuickOption } from "./schedule-send-utils";

const QUICK_OPTION_UI: Record<ScheduleQuickOption["id"], { icon: LucideIcon; labelKey: TranslationKey }> = {
	tomorrowMorning: { icon: Sun, labelKey: "schedule.tomorrowMorning" },
	tomorrowAfternoon: { icon: AfternoonSunIcon, labelKey: "schedule.tomorrowAfternoon" },
	mondayMorning: { icon: BriefcaseBusiness, labelKey: "schedule.mondayMorning" },
};

const tileClass = "flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl px-2 py-4 text-center outline-none transition-colors hover:bg-neutral-100 focus-visible:bg-neutral-100 focus-visible:ring-2 focus-visible:ring-blue-500";

/** Gmail-style schedule send: three quick picks and "Pick date & time" in a 2×2 grid.
 * Choosing a tile schedules the email immediately. */
export function ScheduleSendDialog({ open, onOpenChange, onSchedule }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSchedule: (value: Date) => void;
}) {
	const { t } = useLanguage();
	const [picking, setPicking] = useState(false);
	const [customDay, setCustomDay] = useState("");
	const [customTime, setCustomTime] = useState("08:00");
	// Recomputed each time the dialog opens so "tomorrow" stays correct.
	const options = useMemo(() => (open ? getQuickScheduleOptions() : []), [open]);
	const zoneName = useMemo(() => (open ? getTimeZoneLongName() : ""), [open]);
	const today = useMemo(() => (open ? formatDateTimeLocal(new Date(options[0]?.value ?? 0)).slice(0, 10) : ""), [open, options]);
	const customDate = customDay && customTime ? parseDateTimeLocal(`${customDay}T${customTime}`) : null;
	const customValid = !!customDate && isSchedulableTime(customDate);

	function close(next: boolean) {
		if (!next) { setPicking(false); setCustomDay(""); setCustomTime("08:00"); }
		onOpenChange(next);
	}
	function choose(value: Date) {
		close(false);
		onSchedule(value);
	}

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="w-[min(420px,calc(100vw-32px))] p-4 sm:p-5" closeClassName="hidden" onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogTitle className={picking ? "flex items-center gap-2 text-base" : "sr-only"}>
					{picking && (
						<button type="button" onClick={() => setPicking(false)} className="rounded-full p-1 text-neutral-600 hover:bg-neutral-100" aria-label={t("schedule.back")}>
							<ArrowLeft className="h-4 w-4" />
						</button>
					)}
					{picking ? t("schedule.pickDateTime") : t("schedule.send")}
				</DialogTitle>
				{picking ? (
					<div className="mt-4 space-y-4">
						<div className="grid grid-cols-[3fr_2fr] gap-3">
							<label className="block text-xs text-neutral-500">
								{t("schedule.date")}
								<input
									type="date"
									value={customDay}
									onChange={(event) => setCustomDay(event.target.value)}
									className="mt-1 h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 outline-none focus:border-blue-500"
								/>
							</label>
							<label className="block text-xs text-neutral-500">
								{t("schedule.time")}
								<input
									type="time"
									value={customTime}
									onChange={(event) => setCustomTime(event.target.value)}
									className="mt-1 h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 text-base text-neutral-900 outline-none focus:border-blue-500"
								/>
							</label>
						</div>
						<p className="text-center text-xs text-neutral-500">{t("schedule.timeZoneNote", { zone: zoneName })}</p>
						<div className="flex justify-end gap-2">
							<button type="button" onClick={() => close(false)} className="rounded-full px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100">
								{t("common.cancel")}
							</button>
							<button
								type="button"
								disabled={!customValid}
								onClick={() => customDate && choose(customDate)}
								className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
							>
								{t("schedule.send")}
							</button>
						</div>
					</div>
				) : (
					<>
						<div className="grid grid-cols-2 gap-1 pt-2">
							{options.map((option) => {
								const { icon: Icon, labelKey } = QUICK_OPTION_UI[option.id];
								return (
									<button key={option.id} type="button" onClick={() => choose(option.value)} className={tileClass}>
										<Icon className="h-9 w-9 text-[#e8710a] dark:text-[#fcc9a6]" strokeWidth={1.75} aria-hidden />
										<span className="w-full truncate text-[15px] font-medium text-neutral-900">{t(labelKey)}</span>
										<span className="text-xs text-neutral-500">{t("schedule.optionTime", formatQuickScheduleParts(option.value))}</span>
									</button>
								);
							})}
							<button type="button" onClick={() => { setCustomDay(today); setPicking(true); }} className={tileClass}>
								<CalendarDays className="h-9 w-9 text-[#e8710a] dark:text-[#fcc9a6]" strokeWidth={1.75} aria-hidden />
								<span className="text-[15px] font-medium text-neutral-900">{t("schedule.pickDateTime")}</span>
							</button>
						</div>
						<p className="pt-4 text-center text-xs text-neutral-500">{t("schedule.timeZoneNote", { zone: zoneName })}</p>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
