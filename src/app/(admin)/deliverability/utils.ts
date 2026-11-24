import { authFetch } from "@/lib/auth/client";
import { formatUserDate } from "@/lib/time/utils";
import type { DeliverabilitySettings, DomainOption, SuppressionMode, SuppressionPage } from "./types";

export const PAGE_SIZE = 50;

async function json<T>(response: Response): Promise<T> {
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
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
