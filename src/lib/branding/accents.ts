// Preset accent palettes for the Branding settings page. Each id maps to a
// `--color-blue-*` ramp override in src/app/globals.css (light) and a matching
// `.dark` override, so every `blue-*` utility follows the chosen accent.
export const DEFAULT_ACCENT_COLOR = "blue";

export const ACCENT_COLORS = [
	{ id: "blue", swatch: "#155dfc" },
	{ id: "indigo", swatch: "#4f39f6" },
	{ id: "violet", swatch: "#7f22fe" },
	{ id: "purple", swatch: "#9810fa" },
	{ id: "fuchsia", swatch: "#c800de" },
	{ id: "pink", swatch: "#e60076" },
	{ id: "orange", swatch: "#f54900" },
	{ id: "teal", swatch: "#009689" },
	{ id: "cyan", swatch: "#0092b8" },
	{ id: "emerald", swatch: "#009966" },
	{ id: "slate", swatch: "#45556c" },
] as const;

export type AccentColorId = (typeof ACCENT_COLORS)[number]["id"];

export function isAccentColorId(value: unknown): value is AccentColorId {
	return typeof value === "string" && (ACCENT_COLORS as readonly { id: string }[]).some((preset) => preset.id === value);
}
