import type { TranslationKey } from "@/lib/i18n/types";
export type RichTextEditorProps = {
	id: string;
	/** Editable HTML. */
	value: string;
	onChange: (html: string) => void;
	/** Quoted or forwarded HTML shown folded under the editable area. */
	quotedHtml?: string | null;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	toolbarStart?: React.ReactNode;
	toolbarEnd?: React.ReactNode;
	footerContent?: React.ReactNode;
	/** "top" puts the format buttons above the text on every screen size and drops the bottom bar. */
	toolbarPosition?: "bottom" | "top";
	/** "basic" offers bold, italic, underline, lists and links only. */
	formats?: "full" | "basic";
	/** A shorter text area for small surfaces such as note panels. */
	compact?: boolean;
	/** Accessible name of the text area; defaults to the message body label. */
	ariaLabel?: string;
	/** Called on Ctrl/Cmd+Enter. */
	onSubmitShortcut?: () => void;
};

export type ToolbarCommand = {
	command: string;
	labelKey: TranslationKey;
	icon: React.ComponentType<{ className?: string }>;
	value?: string;
};
