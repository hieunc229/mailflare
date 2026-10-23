import { authFetch } from "@/lib/auth/client";
import type { MessageOpenEvent, MessageTrackingSummary } from "@/lib/tracking/types";

export async function fetchMessageTracking(messageId: string): Promise<MessageTrackingSummary | null> {
	const res = await authFetch(`/api/messages/${messageId}/opens`, { cache: "no-store" });
	if (!res.ok) return null;
	const json = (await res.json()) as { tracking?: MessageTrackingSummary | null };
	return json.tracking ?? null;
}

function countryName(code: string, locale: string): string {
	try {
		return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** "Gmail", "Outlook · iPhone · Zürich, Switzerland"; empty when nothing is known. */
export function describeOpenEvent(event: MessageOpenEvent, locale: string): string {
	const place = [event.city, event.country ? countryName(event.country, locale) : null].filter(Boolean).join(", ");
	return [event.client, event.device, place].filter(Boolean).join(" · ");
}
