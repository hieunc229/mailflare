import type { MailboxOption } from "@/components/mailbox-provider";
import { clearMailboxesCache } from "@/components/mailbox-provider-utils";
import { authFetch } from "@/lib/auth/client";
import type {
	BarkSettingsResponse,
	CurrentMailboxFormResponse,
	ForwardingEmailResponse,
	MailboxAutoReplyResponse,
	MailboxAutoReplySettings,
	MailboxSignatureResponse,
} from "./types";
import type { AccountSettingsResponse, ChangePasswordResponse } from "./types";

export function getMailboxAddress(mailbox: Pick<MailboxOption, "localPart" | "hostname">): string {
	return `${mailbox.localPart}@${mailbox.hostname}`;
}

export async function updateCurrentMailboxName(id: string, displayName: string): Promise<MailboxOption> {
	const res = await authFetch(`/api/mailboxes/${id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ displayName }),
	});
	const data = (await res.json()) as CurrentMailboxFormResponse;

	if (!res.ok || !data.mailbox) {
		throw new Error(typeof data.error === "string" ? data.error : "Failed to update mailbox");
	}
	clearMailboxesCache();

	return {
		id: data.mailbox.id,
		localPart: data.mailbox.localPart,
		hostname: data.mailbox.hostname,
		displayName: data.mailbox.displayName,
		hasAvatar: data.mailbox.hasAvatar,
		isPrimary: data.mailbox.isPrimary,
	};
}

export async function loadAccountSettings(): Promise<Required<AccountSettingsResponse>["user"]> {
	const res = await authFetch("/api/auth/me");
	const data = (await res.json()) as AccountSettingsResponse;

	if (!res.ok || !data.user) {
		throw new Error(typeof data.error === "string" ? data.error : "Failed to load account");
	}

	return data.user;
}

export async function updateForwardingEmail(forwardingEmail: string): Promise<string> {
	const res = await authFetch("/api/settings/forwarding", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ forwardingEmail }),
	});
	const data = (await res.json()) as ForwardingEmailResponse;
	if (!res.ok) {
		throw new Error(typeof data.error === "string" ? data.error : "Failed to update forwarding email");
	}
	return data.forwardingEmail ?? "";
}

export async function saveBarkSettings(barkUrl: string): Promise<string> {
	const res = await authFetch("/api/settings/bark", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ barkUrl }),
	});
	const data = (await res.json()) as BarkSettingsResponse;
	if (!res.ok) {
		const message =
			typeof data.error === "string"
				? data.error
				: data.error && typeof data.error === "object" && "formErrors" in data.error
					? "Invalid Bark URL"
					: "Failed to update Bark settings";
		throw new Error(message);
	}
	return data.barkUrl ?? "";
}

export async function testBarkNotification(): Promise<void> {
	const res = await authFetch("/api/settings/bark/test", {
		method: "POST",
	});
	const data = (await res.json()) as BarkSettingsResponse;
	if (!res.ok) {
		throw new Error(typeof data.error === "string" ? data.error : "Test push failed");
	}
}

export async function updateMailboxSignature(mailboxId: string, signature: string): Promise<string> {
	const res = await authFetch(`/api/mailboxes/${mailboxId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ signature }),
	});
	const data = (await res.json()) as MailboxSignatureResponse;
	if (!res.ok || !data.mailbox) {
		throw new Error(typeof data.error === "string" ? data.error : "Failed to update signature");
	}
	clearMailboxesCache();
	return data.mailbox.signature ?? "";
}

export async function updateMailboxAutoReply(
	mailboxId: string,
	settings: MailboxAutoReplySettings,
): Promise<MailboxAutoReplySettings> {
	const res = await authFetch(`/api/mailboxes/${mailboxId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			autoReplyEnabled: settings.enabled,
			autoReplySubject: settings.subject,
			autoReplyBody: settings.body,
		}),
	});
	const data = (await res.json()) as MailboxAutoReplyResponse;
	if (!res.ok || !data.mailbox) {
		throw new Error(typeof data.error === "string" ? data.error : "Failed to update auto-reply");
	}
	clearMailboxesCache();
	return {
		enabled: data.mailbox.autoReplyEnabled,
		subject: data.mailbox.autoReplySubject,
		body: data.mailbox.autoReplyBody,
	};
}

export async function updatePassword(currentPassword: string, newPassword: string): Promise<void> {
	const res = await authFetch("/api/settings/password", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ currentPassword, newPassword }),
	});
	const data = (await res.json()) as ChangePasswordResponse;

	if (!res.ok) {
		throw new Error(typeof data.error === "string" ? data.error : "Failed to change password");
	}
}
