import type { MailboxOption } from "@/components/mailbox-provider";
import { clearMailboxesCache } from "@/components/mailbox-provider-utils";
import { authFetch } from "@/lib/auth/client";
import type {
	CurrentMailboxFormResponse,
	MailboxAutoReplyResponse,
	MailboxAutoReplySettings,
	MailboxSignatureResponse,
} from "./types";
import type {
	AccountSettingsResponse,
	ChangePasswordResponse,
	MfaEnrollmentResponse,
	MfaRecoveryCodesResponse,
	MfaStatusResponse,
} from "./types";

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
		domainId: data.mailbox.domainId,
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

/** An API key limited to the JMAP scope, for external mail apps. */
export async function createJmapApiKey(name: string, mailboxIds: string[]): Promise<string> {
	const res = await authFetch("/api/api-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name, scopes: ["jmap"], mailboxIds }),
	});
	const data = (await res.json().catch(() => ({}))) as { key?: string; error?: unknown };
	if (!res.ok || !data.key) throw new Error(typeof data.error === "string" ? data.error : "Could not create a key");
	window.dispatchEvent(new Event("mailflare:api-keys-changed"));
	return data.key;
}

function errorMessage(data: { error?: unknown }, fallback: string): string {
	return typeof data.error === "string" ? data.error : fallback;
}

export async function loadMfaStatus(): Promise<MfaStatusResponse> {
	const res = await authFetch("/api/settings/mfa");
	const data = (await res.json()) as MfaStatusResponse;
	if (!res.ok) throw new Error(errorMessage(data, "Failed to load two-factor settings"));
	return data;
}

export async function beginMfaEnrollment(password: string): Promise<Required<Pick<MfaEnrollmentResponse, "secret" | "otpauthUrl" | "qrSvg">>> {
	const res = await authFetch("/api/settings/mfa/enroll", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const data = (await res.json()) as MfaEnrollmentResponse;
	if (!res.ok || !data.secret || !data.otpauthUrl || !data.qrSvg) throw new Error(errorMessage(data, "Could not start enrolment"));
	return { secret: data.secret, otpauthUrl: data.otpauthUrl, qrSvg: data.qrSvg };
}

export async function confirmMfaEnrollment(code: string): Promise<string[]> {
	const res = await authFetch("/api/settings/mfa/confirm", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	const data = (await res.json()) as MfaRecoveryCodesResponse;
	if (!res.ok || !data.recoveryCodes) throw new Error(errorMessage(data, "Could not confirm the code"));
	return data.recoveryCodes;
}

export async function disableMfa(password: string, code: string): Promise<void> {
	const res = await authFetch("/api/settings/mfa/disable", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password, code }),
	});
	const data = (await res.json()) as { error?: unknown };
	if (!res.ok) throw new Error(errorMessage(data, "Could not turn off two-factor authentication"));
}

export async function regenerateRecoveryCodes(password: string): Promise<string[]> {
	const res = await authFetch("/api/settings/mfa/recovery-codes", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const data = (await res.json()) as MfaRecoveryCodesResponse;
	if (!res.ok || !data.recoveryCodes) throw new Error(errorMessage(data, "Could not generate new codes"));
	return data.recoveryCodes;
}
