import { authFetch } from "@/lib/auth/client";
import { formatEmailAddress, getEmailAddress } from "@/lib/email/address";
import type { ContactSuggestion, ContactSuggestionsResponse } from "./recipient-suggestions-types";

export const CONTACT_SUGGESTIONS_LIMIT = 8;

export async function fetchContactSuggestions(
	mailboxId: string,
	query: string,
): Promise<ContactSuggestion[]> {
	const params = new URLSearchParams({
		mailboxId,
		q: query,
		limit: String(CONTACT_SUGGESTIONS_LIMIT),
	});
	const response = await authFetch(`/api/contacts?${params.toString()}`);
	if (!response.ok) return [];
	const data = (await response.json()) as ContactSuggestionsResponse;
	return data.contacts ?? [];
}

/**
 * Suggestions worth showing for the current draft. Blocked contacts and
 * addresses already in the chips never appear; the list stays in server order,
 * which is alphabetical.
 */
export function filterContactSuggestions(
	suggestions: ContactSuggestion[],
	selected: string[],
): ContactSuggestion[] {
	const picked = new Set(selected.map((entry) => getEmailAddress(entry).toLowerCase()));
	const seen = new Set<string>();
	return suggestions.filter((suggestion) => {
		const email = suggestion.email.toLowerCase();
		if (suggestion.blocked || picked.has(email) || seen.has(email)) return false;
		seen.add(email);
		return true;
	});
}

/** What picking a suggestion puts into the chip list: `"Name" <email>` or the bare address. */
export function formatContactSuggestion(suggestion: ContactSuggestion): string {
	return formatEmailAddress(suggestion.email, suggestion.displayName);
}
