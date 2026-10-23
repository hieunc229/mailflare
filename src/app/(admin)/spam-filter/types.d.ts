import type { SpamBrand, SpamIntelligenceStatus } from "@/lib/spam/types";

export type SpamFilterSettingsResponse = SpamIntelligenceStatus & { error?: string };

export type SpamFilterUpdate = {
	spamhausDqsKey?: string | null;
	abuseChAuthKey?: string | null;
	domainAge?: boolean;
	brands?: SpamBrand[];
};

export type BrandLinesResult = { brands: SpamBrand[]; invalidLines: number[] };

export type SpamKeyField = "spamhausDqsKey" | "abuseChAuthKey";
