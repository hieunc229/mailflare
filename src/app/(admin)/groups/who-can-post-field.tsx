"use client";

import { useId } from "react";
import { useLanguage } from "@/components/language-provider";
import type { WhoCanPost } from "./types";
import { WHO_CAN_POST } from "./utils";

export function WhoCanPostField({ value, onChange, disabled }: { value: WhoCanPost; onChange: (value: WhoCanPost) => void; disabled?: boolean }) {
	const { t } = useLanguage();
	const name = useId();
	return <fieldset disabled={disabled} className="space-y-2">
		<legend className="text-sm font-medium text-neutral-900">{t("groups.whoCanPost")}</legend>
		{WHO_CAN_POST.map((option) => {
			const id = `${name}-${option.value}`;
			return <label key={option.value} htmlFor={id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white px-3 py-2.5 has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-blue-600">
				<input id={id} type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="mt-1 h-4 w-4 shrink-0 accent-blue-600" />
				<span className="min-w-0 text-sm"><span className="block font-medium text-neutral-900">{t(option.label)}</span><span className="block text-neutral-600">{t(option.hint)}</span>{option.dmarcNote && <span className="mt-1 block text-xs text-neutral-500">{t("groups.post.dmarcNote")}</span>}</span>
			</label>;
		})}
	</fieldset>;
}
