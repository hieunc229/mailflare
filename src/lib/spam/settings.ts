import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { queryDns } from "@/lib/dns-query";
import type { SpamBrand, SpamIntelligenceConfig, SpamIntelligenceStatus } from "./types";

export const SPAM_SETTINGS_ID = "default";
export const MAX_SPAM_BRANDS = 100;

export const spamBrandSchema = z.object({
	name: z.string().trim().min(2).max(60),
	domains: z.array(z.string().trim().toLowerCase().regex(/^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/)).min(1).max(20),
});

type StoredSettings = { spamhausDqsKey: string | null; abusechAuthKey: string | null; spamDomainAgeCheck: boolean; spamBrands: string | null };

/** Null until migration 0070 adds the columns, so spam analysis keeps running on env vars alone. */
async function readStoredSettings(env: CloudflareEnv): Promise<StoredSettings | null> {
	try {
		const [row] = await getDb(env).select({
			spamhausDqsKey: appSettings.spamhausDqsKey,
			abusechAuthKey: appSettings.abusechAuthKey,
			spamDomainAgeCheck: appSettings.spamDomainAgeCheck,
			spamBrands: appSettings.spamBrands,
		}).from(appSettings).where(eq(appSettings.id, SPAM_SETTINGS_ID)).limit(1);
		return row ?? { spamhausDqsKey: null, abusechAuthKey: null, spamDomainAgeCheck: true, spamBrands: null };
	} catch {
		return null;
	}
}

function parseBrands(value: string | null | undefined): SpamBrand[] {
	if (!value) return [];
	try {
		const parsed = z.array(spamBrandSchema).safeParse(JSON.parse(value));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

function envFlagOff(value: string | undefined) {
	return value?.trim().toLowerCase() === "off";
}

export async function getSpamIntelligenceConfig(env: CloudflareEnv): Promise<SpamIntelligenceConfig> {
	const stored = await readStoredSettings(env);
	return {
		spamhausDqsKey: stored?.spamhausDqsKey || env.SPAMHAUS_DQS_KEY?.trim() || undefined,
		abuseChAuthKey: stored?.abusechAuthKey || env.ABUSECH_AUTH_KEY?.trim() || undefined,
		domainAge: (stored?.spamDomainAgeCheck ?? true) && !envFlagOff(env.SPAM_DOMAIN_AGE_CHECK),
		brands: parseBrands(stored?.spamBrands),
	};
}

export async function getSpamIntelligenceStatus(env: CloudflareEnv): Promise<SpamIntelligenceStatus> {
	const stored = await readStoredSettings(env);
	const source = (saved: string | null | undefined, fromEnv: string | undefined) => saved ? "settings" as const : fromEnv?.trim() ? "env" as const : null;
	return {
		available: stored !== null,
		spamhaus: { source: source(stored?.spamhausDqsKey, env.SPAMHAUS_DQS_KEY) },
		abusech: { source: source(stored?.abusechAuthKey, env.ABUSECH_AUTH_KEY) },
		domainAge: stored?.spamDomainAgeCheck ?? true,
		domainAgeForcedOff: envFlagOff(env.SPAM_DOMAIN_AGE_CHECK),
		brands: parseBrands(stored?.spamBrands),
	};
}

export async function saveSpamIntelligenceSettings(env: CloudflareEnv, values: Partial<Omit<StoredSettings, "spamBrands">> & { spamBrands?: SpamBrand[] }) {
	const set: Partial<typeof appSettings.$inferInsert> = { updatedAt: new Date() };
	if (values.spamhausDqsKey !== undefined) set.spamhausDqsKey = values.spamhausDqsKey;
	if (values.abusechAuthKey !== undefined) set.abusechAuthKey = values.abusechAuthKey;
	if (values.spamDomainAgeCheck !== undefined) set.spamDomainAgeCheck = values.spamDomainAgeCheck;
	if (values.spamBrands !== undefined) set.spamBrands = values.spamBrands.length ? JSON.stringify(values.spamBrands) : null;
	await getDb(env).insert(appSettings).values({ id: SPAM_SETTINGS_ID, ...set }).onConflictDoUpdate({ target: appSettings.id, set });
}

/**
 * Spamhaus answers its permanent test entry 127.0.0.2 with a listing for any working key; an unknown key gets
 * no answer and a blocked one an error code in 127.255.255.0/24.
 */
export async function checkSpamhausKey(key: string): Promise<boolean> {
	const answers = await queryDns(`2.0.0.127.${key}.zen.dq.spamhaus.net`, "A");
	return answers.some((answer) => answer.startsWith("127.0.0.") && answer !== "127.0.0.1");
}

/** abuse.ch rejects an unknown Auth-Key with 401; any other answer means the key was accepted. */
export async function checkAbuseChKey(key: string): Promise<boolean> {
	const response = await fetch("https://urlhaus-api.abuse.ch/v1/host/", {
		method: "POST",
		headers: { "Auth-Key": key, "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ host: "example.com" }),
	});
	if (response.status === 401 || response.status === 403) return false;
	if (!response.ok) throw new Error(`abuse.ch answered ${response.status}`);
	return true;
}
