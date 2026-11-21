"use client";

import { Copy } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";

type FieldProps = {
	/** Unique on the page; the copied mark follows it, since two fields can share a label. */
	id: string;
	label: string;
	value: string;
	/** What the button copies when it differs from what is shown (the grouped password). */
	copyValue?: string;
	onCopy: (id: string, label: string, value: string) => void;
	/** The id of the field copied last. */
	copied: string | null;
	mono?: boolean;
};

/** One labelled value with its own copy button. The value wraps instead of cutting an address off. */
export function Field({ id, label, value, copyValue, onCopy, copied, mono }: FieldProps) {
	const { t } = useLanguage();
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
			<span className="w-full shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500 sm:w-44">{label}</span>
			<code dir="ltr" className={`min-w-0 flex-1 break-all rounded-md bg-white px-2 py-1 text-start text-sm ${mono ? "font-mono" : "font-sans"}`}>{value}</code>
			<Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-0" onClick={() => onCopy(id, label, copyValue ?? value)} aria-label={t("common.copyLabel", { label })}>
				<Copy className="h-4 w-4" aria-hidden="true" />
				{copied === id ? t("common.copied") : t("common.copy")}
			</Button>
		</div>
	);
}
