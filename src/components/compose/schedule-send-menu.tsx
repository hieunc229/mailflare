"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { NewTemplateDialog } from "./new-template-dialog";
import { TemplateMenu } from "./template-menu";
import { formatScheduledSend } from "./schedule-send-utils";
import { ScheduleSendDialog } from "./schedule-send-dialog";
import { ScheduledSendIcon } from "@/components/icons/scheduled-send-icon";
import type { ScheduleSendMenuProps } from "./schedule-send-types";

export function ScheduleSendMenu({ disabled, value, onChange, onScheduleSend, mailboxId, from, onApplyTemplate }: ScheduleSendMenuProps) {
	const { t } = useLanguage();
	const [newTemplateOpen, setNewTemplateOpen] = useState(false);
	const [scheduleOpen, setScheduleOpen] = useState(false);

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
					<DropdownMenu.Item
						onSelect={() => setScheduleOpen(true)}
						className="flex cursor-pointer items-center rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
					>
						<ScheduledSendIcon className="mr-2 h-4 w-4" />
						{t("schedule.send")}
					</DropdownMenu.Item>
					{value && (
						<DropdownMenu.Item
							onSelect={() => onChange(null)}
							className="flex cursor-pointer items-center rounded-md px-3 py-2 outline-none hover:bg-neutral-100 focus:bg-neutral-100"
						>
							<X className="mr-2 h-4 w-4" />
							{t("schedule.clear")} <span className="ml-2 text-xs text-neutral-500">{formatScheduledSend(value)}</span>
						</DropdownMenu.Item>
					)}
				</DropdownMenu.Content>
			</DropdownMenu.Portal>
		</DropdownMenu.Root>
		<ScheduleSendDialog open={scheduleOpen} onOpenChange={setScheduleOpen} onSchedule={onScheduleSend} />
		<NewTemplateDialog open={newTemplateOpen} onOpenChange={setNewTemplateOpen} mailboxId={mailboxId} from={from} />
		</>
	);
}
