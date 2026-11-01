import { authFetch } from "@/lib/auth/client";
import type { AccentColorId } from "@/lib/branding/accents";
import type { BrandingFormResponse } from "./types";

export const BRANDING_ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export async function saveBranding(appName: string, accentColor: AccentColorId, icon: File | null): Promise<BrandingFormResponse> {
	const form = new FormData();
	form.set("appName", appName);
	form.set("accentColor", accentColor);
	if (icon) form.set("icon", icon, icon.name);
	const response = await authFetch("/api/branding", { method: "PUT", body: form });
	const data = (await response.json()) as BrandingFormResponse;
	if (!response.ok) throw new Error(data.error ?? "Unable to save branding");
	return data;
}
