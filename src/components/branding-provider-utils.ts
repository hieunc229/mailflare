import type { Branding } from "@/lib/branding/types";
import { DEFAULT_ACCENT_COLOR } from "@/lib/branding/accents";

export const DEFAULT_BRANDING: Branding = {
	appName: "Mailflare",
	accentColor: DEFAULT_ACCENT_COLOR,
	hasCustomIcon: false,
	canCustomizeBranding: false,
};

export async function fetchBranding(): Promise<Branding> {
	const response = await fetch("/api/branding", { cache: "no-store" });
	if (!response.ok) return DEFAULT_BRANDING;
	return (await response.json()) as Branding;
}
