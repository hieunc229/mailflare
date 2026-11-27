"use client";

import { Check } from "@/components/icons";
import { useLanguage } from "@/components/language-provider";
import { ACCENT_COLORS, type AccentColorId } from "@/lib/branding/accents";
import type { TranslationKey } from "@/lib/i18n/types";

export function AccentColorPicker({ value, onChange }: { value: AccentColorId; onChange: (accent: AccentColorId) => void }) {
	const { t } = useLanguage();
	return (
		<div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t("branding.accentColor")}>
			{ACCENT_COLORS.map((accent) => {
				const selected = accent.id === value;
				return (
					<button
						key={accent.id}
						type="button"
						role="radio"
						aria-checked={selected}
						title={t(`branding.accent.${accent.id}` as TranslationKey)}
						onClick={() => onChange(accent.id)}
						style={{ backgroundColor: accent.swatch }}
						className={`flex h-9 w-9 items-center justify-center rounded-full transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 focus-visible:ring-offset-2 ${selected ? "ring-2 ring-neutral-900 ring-offset-2" : "hover:ring-2 hover:ring-neutral-300 hover:ring-offset-2"}`}
					>
						{selected && <Check className="h-4 w-4 text-white" />}
						<span className="sr-only">{t(`branding.accent.${accent.id}` as TranslationKey)}</span>
					</button>
				);
			})}
		</div>
	);
}
