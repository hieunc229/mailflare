/**
 * Pure alert rules for the daily deliverability job. Spoofing and regression are evaluated on the aggregates of ONE
 * verified reporter at a time (see `mergeReporterAlerts`), so a reporter can only influence its own numbers.
 * `no_reports` is domain-wide: any verified reporter's report resets it. That is a known, accepted limitation
 * (docs/dmarc-reports.md): an attacker with their own DMARC-passing domain can keep it from firing.
 */
export const ALERT_RULES = Object.freeze({
	spoofingMinFailed: 10,
	spoofTopSources: 5,
	regressionMinHistory: 50,
	regressionMinPass: 0.9,
	regressionMaxPass: 0.5,
	regressionMinToday: 10,
	noReportsEnabledDays: 3,
	noReportsSilentDays: 7,
	noReportsRepeatDays: 7,
});

export type SourceTotals = { sourceIp: string; messages: number; passMessages: number };
export type AlertKind = "spoofing" | "auth_regression" | "no_reports";
export type AlertSource = { sourceIp: string; messages: number; failed: number; reporter?: string };
export type AlertDetail = { sources: AlertSource[]; total: number } | { lastReportAt: string | null };
export type EvaluatedAlert = { kind: AlertKind; detail: AlertDetail };

const DAY = 86_400_000;
const top = <T extends { sourceIp: string; failed: number }>(entries: T[]) => entries.sort((a, b) => b.failed - a.failed || a.sourceIp.localeCompare(b.sourceIp)).slice(0, ALERT_RULES.spoofTopSources);

/** Spoofing and regression from one reporter's totals. */
export function evaluateSourceAlerts(input: { yesterday: SourceTotals[]; prior30: SourceTotals[] }): EvaluatedAlert[] {
	const alerts: EvaluatedAlert[] = [];
	const prior = new Map(input.prior30.map((row) => [row.sourceIp, row]));

	const spoofing = input.yesterday
		.filter((row) => row.messages - row.passMessages >= ALERT_RULES.spoofingMinFailed && (prior.get(row.sourceIp)?.passMessages ?? 0) === 0)
		.map((row) => ({ sourceIp: row.sourceIp, messages: row.messages, failed: row.messages - row.passMessages }));
	if (spoofing.length) alerts.push({ kind: "spoofing", detail: { sources: top([...spoofing]), total: spoofing.length } });

	const spoofed = new Set(spoofing.map((row) => row.sourceIp));
	const regressed = input.yesterday
		.filter((row) => {
			const before = prior.get(row.sourceIp);
			return !spoofed.has(row.sourceIp) && before && before.messages >= ALERT_RULES.regressionMinHistory && before.passMessages / before.messages >= ALERT_RULES.regressionMinPass
				&& row.messages >= ALERT_RULES.regressionMinToday && row.passMessages / row.messages < ALERT_RULES.regressionMaxPass;
		})
		.map((row) => ({ sourceIp: row.sourceIp, messages: row.messages, failed: row.messages - row.passMessages }));
	if (regressed.length) alerts.push({ kind: "auth_regression", detail: { sources: top([...regressed]), total: regressed.length } });
	return alerts;
}

export function evaluateNoReports(input: { reportsEnabledAt: Date | null; lastReportAt: Date | null; lastNoReportsAlertAt: Date | null; now: Date }): EvaluatedAlert | null {
	const enabledLongEnough = input.reportsEnabledAt !== null && input.now.getTime() - input.reportsEnabledAt.getTime() >= ALERT_RULES.noReportsEnabledDays * DAY;
	const silent = input.lastReportAt === null || input.now.getTime() - input.lastReportAt.getTime() >= ALERT_RULES.noReportsSilentDays * DAY;
	const throttled = input.lastNoReportsAlertAt !== null && input.now.getTime() - input.lastNoReportsAlertAt.getTime() < ALERT_RULES.noReportsRepeatDays * DAY;
	return enabledLongEnough && silent && !throttled ? { kind: "no_reports", detail: { lastReportAt: input.lastReportAt?.toISOString() ?? null } } : null;
}

/** All three rules on one set of totals (one reporter's, or the whole domain's in tests). */
export function evaluateAlerts(input: {
	yesterday: SourceTotals[];
	prior30: SourceTotals[];
	reportsEnabledAt: Date | null;
	lastReportAt: Date | null;
	lastNoReportsAlertAt: Date | null;
	now: Date;
}): EvaluatedAlert[] {
	const noReports = evaluateNoReports(input);
	return [...evaluateSourceAlerts(input), ...(noReports ? [noReports] : [])];
}

/** One alert per kind for the domain: each reporter's offenders, tagged with the reporter, the busiest five listed. */
export function mergeReporterAlerts(parts: { reporter: string; alerts: EvaluatedAlert[] }[]): EvaluatedAlert[] {
	const merged: EvaluatedAlert[] = [];
	for (const kind of ["spoofing", "auth_regression"] as const) {
		const sources: AlertSource[] = [];
		let total = 0;
		for (const { reporter, alerts } of parts) {
			const alert = alerts.find((entry) => entry.kind === kind);
			if (!alert || !("sources" in alert.detail)) continue;
			total += alert.detail.total;
			for (const source of alert.detail.sources) sources.push({ ...source, reporter });
		}
		if (total > 0) merged.push({ kind, detail: { sources: top(sources), total } });
	}
	return merged;
}
