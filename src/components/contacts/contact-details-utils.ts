import { authFetch } from "@/lib/auth/client";
import { getEmailAddress } from "@/lib/email/address";
import type { ContactDetailsRecord, ContactDetailsResponse } from "./contact-details-types";

export async function fetchContactDetails(
	mailboxId: string,
	address: string,
): Promise<ContactDetailsRecord> {
	const params = new URLSearchParams({ mailboxId, address: getEmailAddress(address) });
	const response = await authFetch(`/api/contacts?${params.toString()}`);
	const data = (await response.json()) as ContactDetailsResponse;
	if (!response.ok || !data.contact) throw new Error(data.error ?? "Unable to load contact");
	return data.contact;
}

export async function updateContactName(
	mailboxId: string,
	address: string,
	displayName: string,
): Promise<ContactDetailsRecord> {
	const response = await authFetch("/api/contacts", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, address: getEmailAddress(address), displayName }),
	});
	const data = (await response.json()) as ContactDetailsResponse;
	if (!response.ok || !data.contact) throw new Error(data.error ?? "Unable to update contact");
	return data.contact;
}
