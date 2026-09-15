import { eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { deviceTokens } from "@/db/schema";
import type {
	PushNotificationPayload,
	ExpoPushMessage,
	ExpoPushResponse,
} from "./types";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Resolves device tokens for the given user IDs and dispatches push
 * notifications via the Expo Push API.
 *
 * This function is intentionally designed to be non-critical: callers should
 * always wrap it in a try/catch so that a push failure never disrupts mail
 * processing or realtime WebSocket delivery.
 */
export async function sendPushNotifications(
	env: CloudflareEnv,
	userIds: string[],
	payload: PushNotificationPayload,
): Promise<void> {
	if (userIds.length === 0) return;

	const db = getDb(env);

	// 1. Look up all registered device tokens for the target users.
	const tokens = await db
		.select({ token: deviceTokens.token })
		.from(deviceTokens)
		.where(inArray(deviceTokens.userId, userIds));

	if (tokens.length === 0) return;

	// 2. Build the Expo push messages.
	const senderDisplay = payload.fromName || payload.from;
	const title = `New email from ${senderDisplay}`;
	const body = payload.subject || "(No subject)";

	const messages: ExpoPushMessage[] = tokens.map(({ token }) => ({
		to: token,
		title,
		body,
		sound: "default" as const,
		priority: "high" as const,
		channelId: "email",
		data: {
			type: payload.type,
			messageId: payload.messageId,
			mailboxId: payload.mailboxId,
		},
	}));

	// 3. Dispatch to Expo Push API.
	const response = await fetch(EXPO_PUSH_URL, {
		method: "POST",
		headers: {
			"Accept": "application/json",
			"Accept-Encoding": "gzip, deflate",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(messages),
	});

	if (!response.ok) {
		console.error(
			`Expo Push API returned ${response.status}: ${await response.text()}`,
		);
		return;
	}

	const result = (await response.json()) as ExpoPushResponse;

	// 4. Token hygiene: collect invalid tokens and delete them.
	const invalidTokens: string[] = [];
	for (let i = 0; i < result.data.length; i++) {
		const ticket = result.data[i];
		if (
			ticket.status === "error" &&
			ticket.details?.error === "DeviceNotRegistered"
		) {
			invalidTokens.push(tokens[i].token);
		}
	}

	if (invalidTokens.length > 0) {
		await cleanupInvalidTokens(env, invalidTokens);
	}
}

/**
 * Removes device tokens that the Expo Push API reported as unregistered.
 * This keeps the database clean and avoids wasting API calls on dead tokens.
 */
async function cleanupInvalidTokens(
	env: CloudflareEnv,
	invalidTokens: string[],
): Promise<void> {
	try {
		const db = getDb(env);
		await db
			.delete(deviceTokens)
			.where(inArray(deviceTokens.token, invalidTokens));
		console.info(
			`Cleaned up ${invalidTokens.length} invalid device token(s)`,
		);
	} catch (error) {
		console.error("Failed to clean up invalid device tokens", error);
	}
}
