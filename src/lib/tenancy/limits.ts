import { and, count, eq, gte, isNull, ne, notLike, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, driveItems, mailboxes, messageAttachments, messages } from "@/db/schema";
import { getEmailAddressList } from "@/lib/email/address";
import type { TenantLimits } from "./types";

/** The plan's cap for `key` in a multi-tenant deployment; null when uncapped (or not multi-tenant). */
export function tenantLimit(env: Pick<CloudflareEnv, "MAILFLARE_TENANT">, key: keyof TenantLimits): number | null {
	const value = env.MAILFLARE_TENANT?.limits[key];
	return typeof value === "number" && value >= 0 ? value : null;
}

/** True once the free trial is over and the workspace never subscribed: it can read its mail (blurred) but nothing else. */
export const isTrialExpired = (env: Pick<CloudflareEnv, "MAILFLARE_TENANT">): boolean => !!env.MAILFLARE_TENANT?.limits.trialExpired;

/** Where the workspace's owner upgrades (the cloud app's checkout), or null when not configured. */
export function upgradeUrl(env: Pick<CloudflareEnv, "MAILFLARE_TENANT" | "CLOUD_URL">): string | null {
	const tenant = env.MAILFLARE_TENANT;
	return tenant && env.CLOUD_URL ? `${env.CLOUD_URL.replace(/\/$/, "")}/billing/checkout?ws=${encodeURIComponent(tenant.id)}` : null;
}

export const TRIAL_ENDED_ERROR = "Your free trial has ended. Upgrade to keep using this feature";

/** An error message when one more domain would exceed the plan, otherwise null. */
export async function getDomainLimitError(env: CloudflareEnv): Promise<string | null> {
	if (isTrialExpired(env)) return TRIAL_ENDED_ERROR;
	const limit = tenantLimit(env, "domains");
	if (limit === null) return null;
	const [row] = await getDb(env).select({ total: count() }).from(domains);
	return (row?.total ?? 0) >= limit ? `Your plan includes ${limit} domain${limit === 1 ? "" : "s"}. Upgrade to add more` : null;
}

export async function getMailboxLimitError(env: CloudflareEnv): Promise<string | null> {
	if (isTrialExpired(env)) return TRIAL_ENDED_ERROR;
	const limit = tenantLimit(env, "mailboxes");
	if (limit === null) return null;
	const [row] = await getDb(env).select({ total: count() }).from(mailboxes);
	return (row?.total ?? 0) >= limit ? `Your plan includes ${limit} mailbox${limit === 1 ? "" : "es"}. Upgrade to add more` : null;
}

/**
 * An error message when `userId` has sent the plan's daily limit (UTC day), otherwise null. Per user, so one busy or
 * compromised mailbox cannot use up the rest of the workspace; the limit is a brake against abuse.
 */
export async function getSendQuotaError(env: CloudflareEnv, userId: string, recipients: number): Promise<string | null> {
	if (isTrialExpired(env)) return "Your free trial has ended. Upgrade to send email";
	const recipientError = await getRecipientQuotaError(env, recipients);
	if (recipientError) return recipientError;
	const limit = tenantLimit(env, "emailsPerUserPerDay");
	if (limit === null) return null;
	const dayStart = new Date();
	dayStart.setUTCHours(0, 0, 0, 0);
	const [row] = await getDb(env).select({ total: count() }).from(messages).where(and(eq(messages.userId, userId), eq(messages.direction, "outbound"), ne(messages.status, "draft"), gte(messages.createdAt, dayStart)));
	if ((row?.total ?? 0) < limit) return null;
	const trialEndsAt = env.MAILFLARE_TENANT?.limits.trialEndsAt;
	if (trialEndsAt && trialEndsAt * 1000 > Date.now()) return `Free trials can send ${limit.toLocaleString()} emails per user per day until ${new Date(trialEndsAt * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Try again tomorrow`;
	return `You can send ${limit.toLocaleString()} emails per day on your plan. Try again tomorrow, or upgrade for more`;
}

/** Free trial: an error when mailing `incoming` more recipients would pass the workspace's daily recipient cap. */
async function getRecipientQuotaError(env: CloudflareEnv, incoming: number): Promise<string | null> {
	const limit = tenantLimit(env, "recipientsPerDay");
	if (limit === null) return null;
	const dayStart = new Date();
	dayStart.setUTCHours(0, 0, 0, 0);
	const rows = await getDb(env).select({ to: messages.toAddr, cc: messages.ccAddr, bcc: messages.bccAddr }).from(messages)
		.where(and(eq(messages.direction, "outbound"), ne(messages.status, "draft"), ne(messages.status, "failed"), gte(messages.createdAt, dayStart)));
	const used = rows.reduce((total, row) => total + [row.to, row.cc, row.bcc].reduce((n, list) => n + getEmailAddressList(list ?? "").length, 0), 0);
	return used + incoming > limit ? `Free trials can email ${limit} recipients per day. Try again tomorrow, or upgrade` : null;
}

/**
 * Bytes the workspace stores as files: mail attachments plus Drive files. A Drive file saved from an attachment
 * points at the attachment's own object (`attachments/...` key), so it is counted once, with the attachment.
 * Trashed items count until they are purged, and an upload in progress counts at its declared size.
 */
export async function getStorageUsed(env: CloudflareEnv): Promise<number> {
	const db = getDb(env);
	const [attachments] = await db.select({ total: sql<number>`coalesce(sum(${messageAttachments.size}), 0)` }).from(messageAttachments);
	const [files] = await db.select({ total: sql<number>`coalesce(sum(${driveItems.size}), 0)` }).from(driveItems)
		.where(and(eq(driveItems.kind, "file"), or(isNull(driveItems.r2Key), notLike(driveItems.r2Key, "attachments/%"))));
	return Number(attachments?.total ?? 0) + Number(files?.total ?? 0);
}

const formatBytes = (bytes: number) => (bytes >= 2 ** 40 ? `${Number((bytes / 2 ** 40).toFixed(1))} TB` : `${Math.round(bytes / 2 ** 30)} GB`);

/**
 * An error message when storing `incomingBytes` more would exceed the plan's storage, otherwise null. It guards what a
 * user adds (Drive uploads, compose attachments, forwards); mail that arrives is always accepted, so a full workspace
 * never loses incoming attachments, it just cannot add more until it frees space or upgrades.
 */
export async function getStorageLimitError(env: CloudflareEnv, incomingBytes: number): Promise<string | null> {
	if (isTrialExpired(env) && incomingBytes > 0) return TRIAL_ENDED_ERROR;
	const limit = tenantLimit(env, "storageBytes");
	if (limit === null || incomingBytes <= 0) return null;
	return (await getStorageUsed(env)) + incomingBytes > limit ? `Your plan includes ${formatBytes(limit)} of storage and it is full. Delete files or upgrade to add more` : null;
}
