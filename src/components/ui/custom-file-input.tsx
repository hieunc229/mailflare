"use client";

import * as React from "react";
import { Upload } from "lucide-react";
import { useLanguage } from "@/components/language-provider";
import { cn } from "@/lib/utils";

function labelText(label: HTMLLabelElement) {
	const copy = label.cloneNode(true) as HTMLLabelElement;
	copy.querySelectorAll("input, button, select, textarea, [data-ui-file-input]").forEach((control) => control.remove());
	return copy.textContent?.trim() ?? "";
}

export const CustomFileInput = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(function CustomFileInput(
	{ className, onChange, onFocus, disabled, required, "aria-label": ariaLabel, "aria-labelledby": ariaLabelledBy, "aria-describedby": ariaDescribedBy, "aria-errormessage": ariaErrorMessage, "aria-invalid": ariaInvalid, "aria-required": ariaRequired, ...props }, forwardedRef,
) {
	const { t } = useLanguage();
	const nativeRef = React.useRef<HTMLInputElement>(null);
	const [names, setNames] = React.useState<string[]>([]);
	const [associatedLabel, setAssociatedLabel] = React.useState<string>();
	const generatedInputId = React.useId();
	const inputId = props.id ?? generatedInputId;
	const descriptionId = React.useId();
	const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
	React.useImperativeHandle(forwardedRef, () => nativeRef.current!, []);
	React.useLayoutEffect(() => {
		const native = nativeRef.current;
		if (!native || ariaLabel || ariaLabelledBy) return;
		setAssociatedLabel(Array.from(native.labels ?? []).map(labelText).filter(Boolean).join(" ") || undefined);
	}, [ariaLabel, ariaLabelledBy, inputId]);
	React.useEffect(() => {
		const form = nativeRef.current?.form;
		const reset = () => setNames([]);
		form?.addEventListener("reset", reset);
		return () => form?.removeEventListener("reset", reset);
	}, [props.form]);
	return <div data-ui-file-input="" className={cn("w-full min-w-0 items-center gap-3 rounded-md border border-neutral-200 bg-white text-sm", className, "flex h-auto min-h-11 px-2 py-1.5")}>
		<input {...props} id={inputId} type="file" ref={nativeRef} disabled={disabled} required={required} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy} aria-describedby={describedBy} aria-errormessage={ariaErrorMessage} aria-invalid={ariaInvalid} aria-required={ariaRequired} className="sr-only" tabIndex={-1} onFocus={(event) => { onFocus?.(event); if (!event.defaultPrevented && nativeRef.current?.nextElementSibling instanceof HTMLElement) nativeRef.current.nextElementSibling.focus(); }} onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []).map((file) => file.name); onChange?.(event); setNames(event.currentTarget.value ? selected : []); }} />
		<button type="button" disabled={disabled} aria-label={ariaLabel ?? associatedLabel ?? t("drive.fileUpload")} aria-labelledby={ariaLabelledBy} aria-describedby={describedBy} aria-errormessage={ariaErrorMessage} aria-invalid={ariaInvalid} aria-required={ariaRequired ?? (required || undefined)} aria-controls={inputId} onClick={() => nativeRef.current?.click()} className="inline-flex shrink-0 items-center gap-2 rounded border border-neutral-200 bg-neutral-50 px-3 py-1.5 text-sm font-medium text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"><Upload className="h-4 w-4" aria-hidden="true" />{t("drive.fileUpload")}</button>
		<span id={descriptionId} aria-live="polite" className="min-w-0 flex-1 truncate pe-2 text-neutral-500" title={names.join(", ")}>{names.length ? names.join(", ") : t("common.none")}</span>
	</div>;
});
