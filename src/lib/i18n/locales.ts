type LocaleEntry = {
	/** The language's own name, shown in the selector. */
	label: string;
	/** Set for right-to-left scripts. */
	dir?: "rtl";
};

// Register a language here with its native name, and add its catalog as `public/locales/<code>.json`.
// English ships in the bundle; other catalogs are static assets fetched when first needed, so they
// do not count toward the Worker size limit.
// Types, validation, cookies, SSR and the selector all derive from this registry.
export const locales = {
	en: { label: "English" },
	"pt-BR": { label: "Português (Brasil)" },
	"pt-PT": { label: "Português (Portugal)" },
	es: { label: "Español" },
	fr: { label: "Français" },
	de: { label: "Deutsch" },
	ru: { label: "Русский" },
	"zh-CN": { label: "中文（简体）" },
	ja: { label: "日本語" },
	id: { label: "Bahasa Indonesia" },
	tr: { label: "Türkçe" },
	vi: { label: "Tiếng Việt" },
	hi: { label: "हिन्दी" },
	ar: { label: "العربية", dir: "rtl" },
	bn: { label: "বাংলা" },
	ur: { label: "اردو", dir: "rtl" },
	mr: { label: "मराठी" },
	te: { label: "తెలుగు" },
	ko: { label: "한국어" },
	it: { label: "Italiano" },
	ta: { label: "தமிழ்" },
	fa: { label: "فارسی", dir: "rtl" },
	ms: { label: "Bahasa Melayu" },
	sw: { label: "Kiswahili" },
	th: { label: "ไทย" },
	gu: { label: "ગુજરાતી" },
	kn: { label: "ಕನ್ನಡ" },
	pl: { label: "Polski" },
	uk: { label: "Українська" },
	nl: { label: "Nederlands" },
	ml: { label: "മലയാളം" },
	pa: { label: "ਪੰਜਾਬੀ" },
	ha: { label: "Hausa" },
	si: { label: "සිංහල" },
} satisfies Record<string, LocaleEntry>;

export type Locale = keyof typeof locales;
export const DEFAULT_LOCALE = "en" satisfies Locale;
export const supportedLocales = Object.keys(locales) as Locale[];
