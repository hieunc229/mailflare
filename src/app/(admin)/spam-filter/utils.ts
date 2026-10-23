import { authFetch } from "@/lib/auth/client";
import type { SpamBrand } from "@/lib/spam/types";
import type { BrandLinesResult, SpamFilterSettingsResponse, SpamFilterUpdate } from "./types";

export const SPAMHAUS_SIGNUP_URL = "https://www.spamhaus.com/data-access/free-data-query-service/";
export const ABUSECH_SIGNUP_URL = "https://auth.abuse.ch/";

const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export async function loadSpamFilterSettings(): Promise<SpamFilterSettingsResponse> {
	const response = await authFetch("/api/admin/spam-filter");
	const data = await response.json() as SpamFilterSettingsResponse;
	if (!response.ok) throw new Error(data.error || "Could not load spam filter settings");
	return data;
}

export async function saveSpamFilterSettings(update: SpamFilterUpdate): Promise<SpamFilterSettingsResponse> {
	const response = await authFetch("/api/admin/spam-filter", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update) });
	const data = await response.json() as SpamFilterSettingsResponse;
	if (!response.ok) throw new Error(data.error || "Could not save spam filter settings");
	return data;
}

/** One brand per line, `Name = domain.ch, domain.com`; blank lines are skipped, unreadable ones reported (1-based). */
export function parseBrandLines(text: string): BrandLinesResult {
	const brands: SpamBrand[] = [];
	const invalidLines: number[] = [];
	text.split("\n").forEach((line, index) => {
		if (!line.trim()) return;
		const [name, list] = line.split("=", 2).map((part) => part?.trim() ?? "");
		const domains = (list ?? "").split(/[\s,;]+/).map((domain) => domain.toLowerCase().replace(/^@/, "")).filter(Boolean);
		if (name.length < 2 || name.length > 60 || !domains.length || domains.length > 20 || !domains.every((domain) => DOMAIN.test(domain))) invalidLines.push(index + 1);
		else brands.push({ name, domains });
	});
	return { brands, invalidLines };
}

export function formatBrandLines(brands: SpamBrand[]): string {
	return brands.map((brand) => `${brand.name} = ${brand.domains.join(", ")}`).join("\n");
}
