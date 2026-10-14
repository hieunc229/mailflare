import type { TranslationKey } from "@/lib/i18n/types";

export type ScheduleSendOption = {
	labelKey: TranslationKey;
	value: Date | null;
};

export type ScheduleSendMenuProps = {
	disabled?: boolean;
	value: Date | null;
	onChange: (value: Date | null) => void;
	mailboxId?: string | null;
	from: string;
	onApplyTemplate: (template: { title: string; html: string }) => void;
};

export type ScheduleSendSheetProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	value: Date | null;
	onChange: (value: Date | null) => void;
	onApplyTemplate: (template: { title: string; html: string }) => void;
	onNewTemplate: () => void;
};
