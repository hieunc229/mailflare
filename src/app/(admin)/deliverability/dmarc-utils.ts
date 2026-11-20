import type { TranslationKey } from "@/lib/i18n/types";
import type { DmarcSeriesDay } from "./types";

export const percent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

export const dayTotal = (day: DmarcSeriesDay) => day.pass + day.failDelivered + day.quarantined + day.rejected;

export const chartMax = (series: DmarcSeriesDay[]) => Math.max(0, ...series.map(dayTotal));

/** Bar height as a share of the tallest bar (at least 2% so a small day stays visible), and each result's share of the bar. */
export function segmentPercents(day: DmarcSeriesDay, max: number) {
	const total = dayTotal(day);
	const share = (value: number) => (total ? (value / total) * 100 : 0);
	return { height: total ? Math.max(2, Math.round((total / max) * 100)) : 0, pass: share(day.pass), failDelivered: share(day.failDelivered), quarantined: share(day.quarantined), rejected: share(day.rejected) };
}

const STUCK_AFTER_MS = 60 * 60 * 1000;

/** A report still `processing` after an hour was most likely killed by the platform's CPU limit. */
export function reportStatusKey(status: string, receivedAt: string, now = Date.now()): "ok" | "processing" | "stuck" | "rejected" | "failed" | "unverified" | "over_budget" {
	if (status === "processing") return now - Date.parse(receivedAt) > STUCK_AFTER_MS ? "stuck" : "processing";
	return status === "ok" || status === "rejected" || status === "unverified" || status === "over_budget" ? status : "failed";
}

const ERROR_CODES = ["ADDRESS_TAKEN", "RECEIVING_REQUIRED", "MULTIPLE_DMARC_RECORDS", "DNS_FAILED", "ROUTING_FAILED", "MIGRATION_REQUIRED", "DMARC_CHANGED", "TLS_RPT_ON"] as const;

export function errorKey(code: string | undefined): TranslationKey | null {
	return (ERROR_CODES as readonly string[]).includes(code ?? "") ? (`dmarc.error.${code}` as TranslationKey) : null;
}
