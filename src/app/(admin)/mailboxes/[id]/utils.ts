import type { MailboxDetail, MailboxDetailResponse } from "./types";

export function getMailboxAddress(mailbox: Pick<MailboxDetail, "localPart" | "hostname">): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export async function fetchMailbox(id: string): Promise<MailboxDetail> {
	const res = await fetch(`/api/mailboxes/${id}`);
	const json = (await res.json()) as MailboxDetailResponse;

	if (!res.ok || !json.mailbox) {
		throw new Error(json.error ?? "Failed to load mailbox");
	}

	return json.mailbox;
}

export async function updateMailboxName(id: string, displayName: string): Promise<MailboxDetail> {
	const res = await fetch(`/api/mailboxes/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ displayName }),
	});
	const json = (await res.json()) as MailboxDetailResponse;

	if (!res.ok || !json.mailbox) {
		throw new Error(json.error ?? "Failed to update mailbox");
	}

	return json.mailbox;
}
