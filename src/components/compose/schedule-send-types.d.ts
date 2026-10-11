import type { TranslationKey } from "@/lib/i18n/types";

export type ScheduleSendOption = {
	labelKey: TranslationKey;
	value: Date | null;
};

export type ScheduleSendMenuProps = {
	disabled?: boolean;
	value: Date | null;
	onChange: (value: Date | null) => void;
	/** Schedule the email for this time right away (Gmail-style). */
	onScheduleSend: (value: Date) => void;
	mailboxId?: string | null;
	from: string;
	onApplyTemplate: (template: { title: string; html: string }) => void;
};
