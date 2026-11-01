import type { AccentColorId } from "@/lib/branding/accents";

export type BrandingFormResponse = {
	appName?: string;
	accentColor?: AccentColorId;
	hasCustomIcon?: boolean;
	error?: string;
};
