import type { TranslationKey } from "@/lib/i18n/types";
import type { LucideIcon } from "@/components/icons";
import type { LicenseStatus } from "@/lib/licenses/types";

export type LicensePlan = {
	name: string;
	price: number;
	descriptionKey: TranslationKey;
	featureKeys: TranslationKey[];
	icon: LucideIcon;
	checkoutUrl: string;
	originalPrice?: number,
};

export type LicenseAction = "activate" | "validate" | "deactivate";

export type ActivatableLicensePlan = "pro" | "team";

export type LicenseResponse = {
	license?: LicenseStatus;
	error?: string;
};
