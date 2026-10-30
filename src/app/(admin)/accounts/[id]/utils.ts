import { authFetch } from "@/lib/auth/client";
import { requestError } from "@/lib/http/client-error";
import { appendOptimizedAvatar } from "@/lib/avatar-upload-client";
import type {
	AccountDetail,
	AccountDetailResponse,
	AccountMailboxAccessItem,
	AccountMailboxAccessResponse,
	AccountMailboxItem,
	DomainOption,
	ManagedAccount,
	ManagedDomain,
	ManagedMailbox,
} from "./types";

export const permissionLabels: Record<NonNullable<AccountMailboxAccessItem["permission"]>, string> = {
	read_only: "Read Only",
	send_as: "Send As",
	send_on_behalf: "Send on Behalf",
	full_access: "Full Access",
};

export async function fetchAccountMailboxAccess(accountId: string): Promise<AccountMailboxAccessResponse> {
	const res = await authFetch(`/api/accounts/${accountId}/mailbox-access`);
	const json = (await res.json()) as AccountMailboxAccessResponse;
	if (!res.ok) throw new Error(json.error ?? "Failed to load account access");
	return json;
}

export async function fetchAccount(accountId: string): Promise<AccountDetail> {
	const res = await authFetch(`/api/accounts/${accountId}`);
	const json = (await res.json()) as AccountDetailResponse;
	if (!res.ok || !json.account) throw new Error(json.error ?? "Failed to load account");
	return json.account;
}

export async function updateAccount(
	accountId: string,
	input: { email: string; name: string; password?: string; disabled: boolean },
): Promise<void> {
	const res = await authFetch(`/api/accounts/${accountId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to update account");
}

export async function fetchDomains(): Promise<DomainOption[]> {
	const res = await authFetch("/api/domains");
	const json = (await res.json()) as { domains?: DomainOption[]; error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load domains");
	return json.domains ?? [];
}

export async function fetchAccountMailboxes(accountId: string): Promise<AccountMailboxItem[]> {
	const res = await authFetch(`/api/accounts/${accountId}/mailboxes`);
	const json = (await res.json()) as { mailboxes?: AccountMailboxItem[]; error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to load account mailboxes");
	return json.mailboxes ?? [];
}

export async function createAccountMailbox(
	accountId: string,
	input: { domainId: string; localPart: string; displayName?: string },
): Promise<void> {
	const res = await authFetch(`/api/accounts/${accountId}/mailboxes`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to create mailbox");
}

export async function grantAccountMailboxAccess(
	accountId: string,
	mailboxId: string,
	permission: NonNullable<AccountMailboxAccessItem["permission"]>,
): Promise<void> {
	const res = await authFetch(`/api/accounts/${accountId}/mailbox-access`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, permission }),
	});
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to update access");
}

export async function revokeAccountMailboxAccess(accountId: string, mailboxId: string): Promise<void> {
	const res = await authFetch(`/api/accounts/${accountId}/mailbox-access?mailboxId=${encodeURIComponent(mailboxId)}`, {
		method: "DELETE",
	});
	const json = (await res.json()) as { error?: string };
	if (!res.ok) throw new Error(json.error ?? "Failed to remove access");
}

export function getMailboxAddress(mailbox: Pick<AccountMailboxAccessItem, "localPart" | "hostname">): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export function getMailboxLabel(mailbox: Pick<AccountMailboxAccessItem, "displayName" | "localPart">): string {
	return mailbox.displayName?.trim() || mailbox.localPart;
}

export async function fetchManagedAccount(accountId: string): Promise<ManagedAccount> {
	const response = await authFetch(`/api/accounts/${accountId}`);
	const data = (await response.json()) as { account?: ManagedAccount; error?: string };
	if (!response.ok || !data.account) throw new Error(data.error ?? "Unable to load account");
	return data.account;
}

export async function saveManagedAccount(account: ManagedAccount, stepUpToken?: string): Promise<void> {
	const response = await authFetch(`/api/accounts/${account.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: account.name,
			role: account.role,
			disabled: account.disabled,
			canManageMailboxes: account.canManageMailboxes,
			canManageDomains: account.canManageDomains,
			canManageUsers: account.canManageUsers,
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
