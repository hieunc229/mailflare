"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { useLanguage } from "@/components/language-provider";
import { useIsMobile } from "@/components/sidebar-mobile-utils";
import { ScheduleSendSheet } from "@/components/compose/schedule-send-sheet";
import { formatDateTimeLocal, formatScheduledSend, getScheduleSendOptions, isPastSchedule, parseDateTimeLocal } from "@/components/compose/schedule-send-utils";
import { getUserTimeZone } from "@/lib/time/utils";

const buttonClass = "shrink-0 font-medium text-blue-600 hover:underline disabled:opacity-50";

/** Reschedule control on a scheduled message: the bottom sheet on phones, a
 * dropdown with preset times and a date picker on desktop. */
export function ScheduledSendReschedule({ scheduledAt, disabled, onPick }: { scheduledAt: string; disabled?: boolean; onPick: (date: Date) => void }) {
	const { t } = useLanguage();
	const isPhone = useIsMobile();
	const [sheetOpen, setSheetOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [pickedText, setPickedText] = useState<string | null>(null);
	const options = getScheduleSendOptions();
	const picked = pickedText === null ? null : parseDateTimeLocal(pickedText);
	const pastPicked = picked !== null && isPastSchedule(picked);

	// The date input fires change for every valid half-typed value, so the time is
	// committed once, on Enter or when the field loses focus.
	function commit() {
		if (pickedText === null) return;
		const parsed = parseDateTimeLocal(pickedText);
		if (!parsed || isPastSchedule(parsed) || parsed.getTime() === new Date(scheduledAt).getTime()) return;
		setMenuOpen(false);
		onPick(parsed);
	}

	if (isPhone) {
		return (
			<>
				<button type="button" onClick={() => setSheetOpen(true)} disabled={disabled} className={buttonClass}>
					{t("schedule.reschedule")}
				</button>
				<ScheduleSendSheet
					open={sheetOpen}
					onOpenChange={setSheetOpen}
					value={new Date(scheduledAt)}
					allowClear={false}
					onChange={(date) => { if (date) onPick(date); }}
				/>
			</>
		);
	}

	return (
		<DropdownMenu.Root open={menuOpen} onOpenChange={(next) => { setMenuOpen(next); setPickedText(null); }}>
			<DropdownMenu.Trigger type="button" disabled={disabled} className={buttonClass}>
				{t("schedule.reschedule")}
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-56 rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg">
					{options.map((option) => (
						<DropdownMenu.Item
							key={option.labelKey}
							onSelect={() => { if (option.value) onPick(option.value); }}
							className="cursor-pointer rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
						>
							{t(option.labelKey)}
							<span className="ml-2 text-xs text-neutral-500">{option.value && formatScheduledSend(option.value)}</span>
						</DropdownMenu.Item>
					))}
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">
						{t("schedule.pick", { timeZone: getUserTimeZone() })}
					</DropdownMenu.Label>
					<input
						type="datetime-local"
						min={formatDateTimeLocal(new Date())}
						value={pickedText ?? formatDateTimeLocal(new Date(scheduledAt))}
						onChange={(event) => setPickedText(event.target.value)}
						onBlur={commit}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Enter") commit();
						}}
						aria-invalid={pastPicked}
						aria-describedby={pastPicked ? "schedule-past-time" : undefined}
						className="mx-2 mb-2 h-9 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400"
					/>
					{pastPicked && <p id="schedule-past-time" role="alert" className="mx-2 mb-2 text-xs text-red-600">{t("schedule.pastTime")}</p>}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
	);
}
