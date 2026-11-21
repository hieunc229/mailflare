import { defaultTranslator, type Translator } from "@/lib/i18n/utils";
import { Building2, Sparkles } from "@/components/icons";
import type { LicensePlan } from "./types";
import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import { LICENSE_STATUS_CHANGED_EVENT } from "@/lib/licenses/constants";
import type { ActivatableLicensePlan, LicenseAction, LicenseResponse } from "./types";

export const LICENSE_PLANS: LicensePlan[] = [];

export async function loadLicenseStatus(): Promise<NonNullable<LicenseResponse["license"]>> {
	const response = await authFetch("/api/licenses");
	const data = (await response.json()) as LicenseResponse;
	if (!response.ok || !data.license) throw new Error(data.error ?? defaultTranslator("licenses.loadFailed"));
	return data.license;
}

export async function runLicenseAction(
	action: LicenseAction,
	licenseKey: string,
	plan?: ActivatableLicensePlan,
): Promise<NonNullable<LicenseResponse["license"]>> {
	const response = await authFetch(`/api/licenses/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ licenseKey, ...(plan ? { plan } : {}) }),
	});
	const data = (await response.json()) as LicenseResponse;
	if (!response.ok || !data.license) throw new Error(data.error ?? defaultTranslator("licenses.requestFailed"));
	window.dispatchEvent(new Event(LICENSE_STATUS_CHANGED_EVENT));
	return data.license;
}

export function formatLicensePlan(plan: string, t: Translator = defaultTranslator): string {
	return plan === "team" ? "Team" : plan === "pro" ? "Pro" : t("licenses.communityPlan");
}

export function formatLicenseDate(value: Date | string | null): string | null {
	if (!value) return null;
	return formatUserDate(value, { dateStyle: "medium", timeStyle: "short" });
}
