"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { NewTemplateDialog } from "./new-template-dialog";
import { TemplateMenu } from "./template-menu";
import {
	formatDateTimeLocal,
	formatScheduledSend,
	getScheduleSendOptions,
	parseDateTimeLocal,
} from "./schedule-send-utils";
import type { ScheduleSendMenuProps } from "./schedule-send-types";
import { getUserTimeZone } from "@/lib/time/utils";

export function ScheduleSendMenu({ disabled, value, onChange, mailboxId, from, onApplyTemplate }: ScheduleSendMenuProps) {
	const { t } = useLanguage();
	const [newTemplateOpen, setNewTemplateOpen] = useState(false);
	const options = getScheduleSendOptions();
	const minimum = new Date(Date.now() + 5 * 60 * 1000);

	return (
		<>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				type="button"
				disabled={disabled}
				aria-label={t("schedule.optionsLabel")}
				className="inline-flex h-8 items-center justify-center rounded-r-lg border-l border-blue-500 bg-blue-600 px-2 text-white transition-colors hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
			>
				<ChevronDown className="h-4 w-4" />
			</DropdownMenu.Trigger>
			<DropdownMenu.Portal>
				<DropdownMenu.Content
					align="start"
					sideOffset={6}
					className="z-50 min-w-56 rounded-lg border border-neutral-200 bg-white p-1 text-sm shadow-lg"
				>
					<TemplateMenu onApply={onApplyTemplate} onNew={() => setNewTemplateOpen(true)} />
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">{t("schedule.heading")}</DropdownMenu.Label>
					{value && (
						<>
							<DropdownMenu.Item
								onSelect={() => onChange(null)}
								className="flex cursor-pointer items-center rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
							>
								<X className="mr-2 h-4 w-4" />
								{t("schedule.clear")}
							</DropdownMenu.Item>
							<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
						</>
					)}
					{options.map((option) => (
						<DropdownMenu.Item
							key={option.labelKey}
							onSelect={() => onChange(option.value)}
							className="cursor-pointer rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
						>
							{t(option.labelKey)}
							<span className="ml-2 text-xs text-neutral-500">
								{option.value && formatScheduledSend(option.value)}
							</span>
						</DropdownMenu.Item>
					))}
					<DropdownMenu.Separator className="my-1 h-px bg-neutral-100" />
					<DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs font-medium text-neutral-500">
						{t("schedule.pick", { timeZone: getUserTimeZone() })}
					</DropdownMenu.Label>
					<input
						type="datetime-local"
						min={formatDateTimeLocal(minimum)}
						value={value ? formatDateTimeLocal(value) : ""}
						onChange={(event) => onChange(parseDateTimeLocal(event.target.value))}
						onKeyDown={(event) => event.stopPropagation()}
						className="mx-2 mb-2 h-9 rounded-md border border-neutral-200 px-2 text-sm outline-none focus:border-blue-400"
					/>
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
		<NewTemplateDialog open={newTemplateOpen} onOpenChange={setNewTemplateOpen} mailboxId={mailboxId} from={from} />
		</>
	);
}
