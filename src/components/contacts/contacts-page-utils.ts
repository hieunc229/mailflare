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

export async function exportContacts(mailboxId: string): Promise<void> {
	const params = new URLSearchParams({ mailboxId });
	const response = await authFetch(`/api/export/contacts?${params.toString()}`);
	if (!response.ok) {
		const data = (await response.json()) as { error?: string };
		throw new Error(data.error ?? "Unable to export contacts");
	}

	const blob = await response.blob();
	// The server names the file; Content-Disposition keeps that the single source of truth.
	const filename = response.headers.get("Content-Disposition")?.match(/filename="?([^";]+)"?/)?.[1] ?? "contacts.vcf";
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

export async function deleteContact(mailboxId: string, address: string): Promise<void> {
	const params = new URLSearchParams({ mailboxId, address });
	const response = await authFetch(`/api/contacts?${params.toString()}`, { method: "DELETE" });
	if (!response.ok) {
		const data = (await response.json()) as ContactMutationResponse;
		throw new Error(data.error ?? "Unable to delete contact");
	}
}

/** Shared by the header and rows so the columns line up. */
export const CONTACT_COLUMNS =
	"grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 md:grid-cols-[auto_minmax(0,2fr)_minmax(0,1fr)_auto]";
