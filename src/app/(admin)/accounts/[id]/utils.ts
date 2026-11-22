import { authFetch } from "@/lib/auth/client";
import { requestError } from "@/lib/http/client-error";
import { appendOptimizedAvatar } from "@/lib/avatar-upload-client";
import type {
	ManagedAccount,
	ManagedDomain,
	ManagedMailbox,
} from "./types";

export async function fetchManagedAccount(accountId: string): Promise<ManagedAccount> {
	const response = await authFetch(`/api/accounts/${accountId}`);
	const data = (await response.json()) as { account?: ManagedAccount; error?: string };
	if (!response.ok || !data.account) throw new Error(data.error ?? "Unable to load account");
	return data.account;
}

export async function saveManagedAccount(account: ManagedAccount, stepUpToken?: string): Promise<void> {
	const response = await authFetch(`/api/accounts/${account.id}`, {
		method: "PATCH",
		// With a proof attached, a 401 means the proof was refused, not that the session ended.
		redirectOnUnauthorized: !stepUpToken,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: account.name,
			role: account.role,
			disabled: account.disabled,
			canManageMailboxes: account.canManageMailboxes,
			canManageDomains: account.canManageDomains,
			canManageUsers: account.canManageUsers,
			calendarEnabled: account.calendarEnabled,
			driveEnabled: account.driveEnabled,
			forwardingEmail: account.forwardingEmail,
			password: account.newPassword || undefined,
			stepUpToken,
		}),
	});
	const data = (await response.json()) as { error?: string; code?: string };
	if (!response.ok) throw requestError(data, "Unable to update account");
}

export type TransferCandidate = {
	id: string;
	email: string;
	name: string;
	hasAvatar: boolean;
	disabled: boolean;
};

export async function fetchTransferCandidates(): Promise<TransferCandidate[]> {
	const response = await authFetch("/api/accounts");
	const data = (await response.json()) as { accounts?: Array<{ id: string; email: string; name: string; hasAvatar?: boolean; disabled?: boolean }>; error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to load accounts");
	return (data.accounts ?? []).map((account) => ({
		id: account.id,
		email: account.email,
		name: account.name,
		hasAvatar: !!account.hasAvatar,
		disabled: !!account.disabled,
	}));
}

export async function transferPrimaryAdmin(accountId: string): Promise<void> {
	const response = await authFetch(`/api/accounts/${accountId}/transfer-primary`, { method: "POST" });
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to transfer the primary admin role");
}

export async function uploadManagedAccountAvatar(accountId: string, file: File): Promise<void> {
	const form = new FormData();
	await appendOptimizedAvatar(form, file);
	const response = await authFetch(`/api/accounts/${accountId}/avatar`, { method: "POST", body: form });
	if (!response.ok) throw new Error("Unable to update avatar");
}

export function getManagedAccountAvatarUrl(accountId: string, version: number): string {
	return `/api/accounts/${accountId}/avatar${version ? `?v=${version}` : ""}`;
}

export async function fetchManagedMailboxes(accountId: string): Promise<ManagedMailbox[]> {
	const response = await authFetch(`/api/accounts/${accountId}/mailboxes`);
	const data = (await response.json()) as { mailboxes?: ManagedMailbox[]; error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to load mailboxes");
	return data.mailboxes ?? [];
}

export async function fetchManagedDomains(): Promise<ManagedDomain[]> {
	const response = await authFetch("/api/domains");
	const data = (await response.json()) as { domains?: ManagedDomain[]; error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to load domains");
	return data.domains ?? [];
}

export async function addManagedMailbox(
	account: ManagedAccount,
	input: { domainId: string; localPart: string },
): Promise<void> {
	const response = await authFetch("/api/mailboxes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			ownerUserId: account.id,
			domainId: input.domainId,
			localPart: input.localPart,
			displayName: account.name,
			type: "personal",
		}),
	});
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to add mailbox");
}

export async function removeManagedMailbox(mailboxId: string): Promise<void> {
	const response = await authFetch(`/api/mailboxes/${mailboxId}`, { method: "DELETE" });
	const data = (await response.json()) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? "Unable to remove mailbox");
}
