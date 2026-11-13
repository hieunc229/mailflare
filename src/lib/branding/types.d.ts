import type { AccentColorId } from "./accents";

export type Branding = {
	appName: string;
	accentColor: AccentColorId;
	hasCustomIcon: boolean;
	canCustomizeBranding: boolean;
};
