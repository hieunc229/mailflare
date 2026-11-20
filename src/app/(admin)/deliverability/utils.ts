import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import type { DeliverabilitySettings, DmarcOverview, DmarcRange, DmarcStats, DomainOption, MtaStsBody, MtaStsOverview, MtaStsState, ReportsResponse, SuppressionMode, SuppressionPage, TlsOverview, TlsRptResponse } from "./types";

export const PAGE_SIZE = 50;

async function json<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
	if (!response.ok) throw Object.assign(new Error(body.error ?? `Request failed (${response.status})`), { code: body.code });
	return body;
}

export async function fetchDomains(): Promise<DomainOption[]> {
	const { domains } = await json<{ domains: DomainOption[] }>(await authFetch("/api/domains", { cache: "no-store" }));
	return domains.map(({ id, hostname }) => ({ id, hostname }));
}

export async function fetchSettings(): Promise<DeliverabilitySettings> {
	return json(await authFetch("/api/deliverability/settings", { cache: "no-store" }));
}

export async function saveMode(suppressionMode: SuppressionMode): Promise<DeliverabilitySettings> {
	return json(await authFetch("/api/deliverability/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suppressionMode }) }));
}

export async function setFeed(feed: "resend" | "ses", enabled: boolean): Promise<void> {
	await json(await authFetch(`/api/deliverability/feeds/${feed}`, { method: enabled ? "POST" : "DELETE" }));
}

export async function fetchSuppressions(domainId: string, query: { q: string; reason: string; offset: number }): Promise<SuppressionPage> {
	const params = new URLSearchParams({ offset: String(query.offset), limit: String(PAGE_SIZE) });
	if (query.q.trim()) params.set("q", query.q.trim());
	if (query.reason) params.set("reason", query.reason);
	return json(await authFetch(`/api/deliverability/${encodeURIComponent(domainId)}/suppressions?${params}`, { cache: "no-store" }));
}

export async function deleteSuppression(domainId: string, id: string): Promise<void> {
	await json(await authFetch(`/api/deliverability/${encodeURIComponent(domainId)}/suppressions/${encodeURIComponent(id)}`, { method: "DELETE" }));
}

export async function confirmSuppression(domainId: string, id: string): Promise<void> {
	await json(await authFetch(`/api/deliverability/${encodeURIComponent(domainId)}/suppressions/${encodeURIComponent(id)}`, { method: "PATCH" }));
}

export const formatEventDate = (value: string) => formatUserDate(value, { dateStyle: "medium", timeStyle: "short" });

const base = (domainId: string) => `/api/deliverability/${encodeURIComponent(domainId)}`;

export async function fetchOverview(domainId: string): Promise<DmarcOverview> {
	return json(await authFetch(base(domainId), { cache: "no-store" }));
}

export async function fetchDmarc(domainId: string, days: DmarcRange): Promise<DmarcStats> {
	return json(await authFetch(`${base(domainId)}/dmarc?days=${days}`, { cache: "no-store" }));
}

export async function putReports(domainId: string, body: { enabled?: boolean; alertEmail?: boolean; confirm?: boolean; previewed?: { before: string | null; after: string | null } }): Promise<ReportsResponse> {
	return json(await authFetch(`${base(domainId)}/reports`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

export async function acknowledgeAlert(domainId: string, alertId: string): Promise<void> {
	await json(await authFetch(`${base(domainId)}/alerts/${encodeURIComponent(alertId)}`, { method: "PATCH" }));
}

export async function fetchTls(domainId: string, days: DmarcRange): Promise<TlsOverview> {
	return json(await authFetch(`${base(domainId)}/tls?days=${days}`, { cache: "no-store" }));
}

export async function putTlsRpt(domainId: string, enabled: boolean): Promise<TlsRptResponse> {
	return json(await authFetch(`${base(domainId)}/tls-rpt`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }));
}

export async function fetchMtaSts(domainId: string): Promise<MtaStsOverview> {
	return json(await authFetch(`${base(domainId)}/mta-sts`, { cache: "no-store" }));
}

export async function putMtaSts(domainId: string, body: MtaStsBody): Promise<{ kind: "ok"; state: MtaStsState }> {
	return json(await authFetch(`${base(domainId)}/mta-sts`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

export async function postMtaStsVerified(domainId: string): Promise<void> {
	await json(await authFetch(`${base(domainId)}/mta-sts/verified`, { method: "POST" }));
}
