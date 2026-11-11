import { authFetch } from "@/lib/auth/client";
import type {
	ContactListItem,
	ContactMutationResponse,
	ContactsListResponse,
} from "./contacts-page-types";

export const CONTACTS_QUERY_LIMIT = 500;

export async function fetchContacts(mailboxId: string, query: string): Promise<ContactListItem[]> {
	const params = new URLSearchParams({ mailboxId, limit: String(CONTACTS_QUERY_LIMIT) });
	if (query.trim()) params.set("q", query.trim());
	const response = await authFetch(`/api/contacts?${params.toString()}`);
	const data = (await response.json()) as ContactsListResponse;
	if (!response.ok) throw new Error(data.error ?? "Unable to load contacts");
	return data.contacts ?? [];
}

export async function createContact(
	mailboxId: string,
	input: { address: string; displayName?: string },
): Promise<ContactListItem> {
	const response = await authFetch("/api/contacts", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, address: input.address, displayName: input.displayName }),
	});
	const data = (await response.json()) as ContactMutationResponse;
	if (!response.ok || !data.contact) throw new Error(data.error ?? "Unable to save contact");
	return data.contact;
}

export async function renameContact(
	mailboxId: string,
	address: string,
	displayName: string,
): Promise<ContactListItem> {
	const response = await authFetch("/api/contacts", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, address, displayName }),
	});
	const data = (await response.json()) as ContactMutationResponse;
	if (!response.ok || !data.contact) throw new Error(data.error ?? "Unable to save contact");
	return data.contact;
}

export async function deleteContact(mailboxId: string, address: string): Promise<void> {
	const params = new URLSearchParams({ mailboxId, address });
	const response = await authFetch(`/api/contacts?${params.toString()}`, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json()) as ContactMutationResponse;
		throw new Error(data.error ?? "Unable to delete contact");
	}
}
