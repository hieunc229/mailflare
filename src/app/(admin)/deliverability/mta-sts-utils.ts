import type { TranslationKey } from "@/lib/i18n/types";

/** Compares line by line, ignoring line endings and trailing blank lines, so a host behind a proxy that rewrites CRLF still matches. */
const lines = (text: string) => text.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n").map((line) => line.trimEnd());
export const policyMatches = (expected: string, fetched: string) => fetched.trim() !== "" && lines(expected).join("\n") === lines(fetched).join("\n");

const TLS_CODES = ["REPORTS_REQUIRED", "MULTIPLE_TLSRPT_RECORDS", "DNS_FAILED", "MIGRATION_REQUIRED"] as const;
const MTA_STS_CODES = ["NO_MX", "TOO_MANY_MX", "MTA_STS_RECORD_EXISTS", "MULTIPLE_MTA_STS_RECORDS", "TESTING_FIRST", "ACKNOWLEDGE_REQUIRED", "INVALID_MX", "MX_CHANGED_IN_ENFORCE", "NOT_PUBLISHED", "INVALID_MAX_AGE", "DNS_FAILED", "MIGRATION_REQUIRED"] as const;

export const tlsErrorKey = (code: string | undefined): TranslationKey | null => ((TLS_CODES as readonly string[]).includes(code ?? "") ? (`tls.error.${code}` as TranslationKey) : null);
export const mtaStsErrorKey = (code: string | undefined): TranslationKey | null => ((MTA_STS_CODES as readonly string[]).includes(code ?? "") ? (`mtasts.error.${code}` as TranslationKey) : null);

/** True when a published policy lists other MX hosts than the domain has now; false when off or when DNS could not be read. */
export const mxDiffers = (data: { status: string; mxDrift?: { differs: boolean } | { error: true } | null }) => data.status !== "off" && Boolean(data.mxDrift && "differs" in data.mxDrift && data.mxDrift.differs);

/** The cache times the server accepts (one day to one year): a day, a week, 30 days, a year. */
export const MAX_AGE_OPTIONS = [86_400, 604_800, 2_592_000, 31_557_600] as const;

/** How long the removal policy is served, in whole days, rounded up. */
export const retiringDays = (maxAge: number) => Math.ceil(maxAge / 86_400);

export const policyKey = (type: string): TranslationKey | null => (type === "sts" || type === "tlsa" || type === "no-policy-found" ? (`tls.policy.${type}` as TranslationKey) : null);
