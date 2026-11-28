import type { TranslationKey } from "@/lib/i18n/types";
export type RichTextEditorProps = {
	id: string;
	/** Editable HTML. */
	value: string;
	/** The controlled value is raw HTML source. Sanitize it at persistence boundaries. */
	valueIsSource?: boolean;
	onChange: (html: string, fromSource?: true) => void;
	/** Enable rich clipboard paste and HTML source editing in the mail composer. */
	enableHtmlComposition?: boolean;
	/** Quoted or forwarded HTML shown folded under the editable area. */
	quotedHtml?: string | null;
	disabled?: boolean;
	placeholder?: string;
	className?: string;
	/** Extra classes on the editable area itself, e.g. a smaller min-height for short inputs. */
	editableClassName?: string;
	/** Set false to collapse the toolbar row, e.g. until the field is focused. */
	toolbarVisible?: boolean;
	/** Extra classes on the toolbar row itself, e.g. removing its top border. */
	toolbarClassName?: string;
	toolbarStart?: React.ReactNode;
	toolbarEnd?: React.ReactNode;
	footerContent?: React.ReactNode;
};

export type ToolbarCommand = {
	command: string;
	labelKey: TranslationKey;
	icon: React.ComponentType<{ className?: string }>;
	value?: string;
};
