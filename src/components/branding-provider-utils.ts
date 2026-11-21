import type { Branding } from "@/lib/branding/types";

export const DEFAULT_BRANDING: Branding = {
	appName: "Varunya Mail",
	hasCustomIcon: false,
	canCustomizeBranding: true,
};

export async function fetchBranding(): Promise<Branding> {
	const response = await fetch("/api/branding", { cache: "no-store" });
	if (!response.ok) return DEFAULT_BRANDING;
	return (await response.json()) as Branding;
}
