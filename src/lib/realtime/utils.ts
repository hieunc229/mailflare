import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxAccess, mailboxes } from "@/db/schema";
import { isTeamMailboxSharingEnabled } from "@/lib/mailboxes/access-utils";
import { getUserMailRevision } from "./revision";
import type { NewMessageNotification, AgentDraftNotification, RevisionNotification } from "./types";
import { sendPushNotifications } from "@/lib/push/server";
import { sendNativePush } from "@/lib/push/native";

export function getSessionTokenFromRequest(request: Request): string | undefined {
	const cookie = request.headers.get("Cookie");
	if (!cookie) return undefined;

	for (const part of cookie.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === "ep_session") {
			const value = valueParts.join("=");
			return value ? decodeURIComponent(value) : undefined;
		}
	}

	return undefined;
}

export async function getMailboxNotificationUserIds(
	env: CloudflareEnv,
	mailboxId: string,
	ownerUserId: string,
): Promise<string[]> {
	const db = getDb(env);
	const mailboxRows = await db
		.select({ domainOwnerUserId: domains.userId, type: mailboxes.type })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(mailboxes.id, mailboxId))
		.limit(1);
	const sharedUserIds = mailboxRows[0]?.type === "shared" && await isTeamMailboxSharingEnabled(db)
		? (await db
			.select({ userId: mailboxAccess.userId })
			.from(mailboxAccess)
			.where(eq(mailboxAccess.mailboxId, mailboxId)))
			.map((access) => access.userId)
		: [];

	return [
		...new Set([
			ownerUserId,
			mailboxRows[0]?.domainOwnerUserId,
			...sharedUserIds,
		].filter((userId): userId is string => !!userId)),
	];
}

export async function notifyUsersOfNewMessage(
	env: CloudflareEnv,
	userIds: string[],
	payload: NewMessageNotification | AgentDraftNotification,
	options: { silent?: boolean } = {},
): Promise<void> {
	// Next dev uses a bindings-only proxy; realtime delivery runs in worker.ts.
	if (!env.REALTIME) return;
	if (options.silent) return refreshUsersSilently(env, userIds);
	const results = await Promise.allSettled([
		...userIds.map((userId) => {
			const hub = env.REALTIME.getByName(userId);
			return hub.fetch("https://mailflare-realtime/notify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		}),
		...(payload.type === "agent_draft" ? [] : [sendPushNotifications(env, userIds, payload), sendNativePush(env, userIds, payload)]),
	]);
	for (const result of results) {
		if (result.status === "rejected") console.error("New-message notification failed", result.reason);
	}
}

/** No popup and no push: tells open sessions their lists changed through the same revision message the heartbeat uses. */
async function refreshUsersSilently(env: CloudflareEnv, userIds: string[]): Promise<void> {
	const results = await Promise.allSettled(userIds.map(async (userId) => {
		const notification: RevisionNotification = { type: "revision", revision: await getUserMailRevision(env, userId), changed: true };
		await env.REALTIME.getByName(userId).fetch("https://mailflare-realtime/notify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(notification),
		});
	}));
	for (const result of results) {
		if (result.status === "rejected") console.error("Silent refresh notification failed", result.reason);
	}
}
