import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { pushDevices } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { NewMessageNotification } from "@/lib/realtime/types";
import { encryptPreview, importApnsKey, signApnsJwt } from "./native-crypto";
import { isRelayHandle, relayBaseUrl, sendViaRelay } from "./relay";

/**
 * Native push relay for the mobile apps (APNs). Configured with the
 * `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_PRIVATE_KEY` (the .p8 contents)
 * secrets; without them registrations are kept but nothing is sent.
 */
type ApnsConfig = { keyId: string; teamId: string; privateKey: string };

function apnsConfig(env: CloudflareEnv): ApnsConfig | null {
	const keyId = env.APNS_KEY_ID?.trim();
	const teamId = env.APNS_TEAM_ID?.trim();
	const privateKey = env.APNS_PRIVATE_KEY?.trim();
	return keyId && teamId && privateKey ? { keyId, teamId, privateKey } : null;
}

/** Whether a registration with this token can be delivered: a relay handle needs the relay, an APNs token needs a key. */
export function canDeliverTo(env: CloudflareEnv, token: string): boolean {
	return isRelayHandle(token) ? relayBaseUrl(env) !== null : apnsConfig(env) !== null;
}

/** APNs accepts a provider token for up to an hour; refresh well before. */
let cachedToken: { value: string; keyId: string; expiresAt: number } | null = null;

async function providerToken(config: ApnsConfig): Promise<string> {
	const now = Date.now();
	if (cachedToken && cachedToken.keyId === config.keyId && cachedToken.expiresAt > now) return cachedToken.value;
	const key = await importApnsKey(config.privateKey);
	const value = await signApnsJwt(key, config.keyId, config.teamId, Math.floor(now / 1000));
	cachedToken = { value, keyId: config.keyId, expiresAt: now + 45 * 60 * 1000 };
	return value;
}

export type PushRegistration = {
	platform: "apns";
	token: string;
	environment: "production" | "sandbox";
	topic: string;
	publicKey: string | null;
	previews: boolean;
	/** The app's id for the account, echoed back in pushes. */
	clientRef?: string | null;
};

/** Registers a device token for the user (and key) that authenticated; other accounts on the same device keep theirs. */
export async function registerPushDevice(env: CloudflareEnv, userId: string, apiKeyId: string, registration: PushRegistration): Promise<void> {
	const now = new Date();
	// One registration per device key: a token (or relay handle) replaces the one it superseded.
	await getDb(env).delete(pushDevices).where(and(eq(pushDevices.apiKeyId, apiKeyId), ne(pushDevices.token, registration.token)));
	await getDb(env)
		.insert(pushDevices)
		.values({ id: newId("pdev"), userId, apiKeyId, ...registration, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: [pushDevices.platform, pushDevices.token, pushDevices.userId],
			set: { apiKeyId, clientRef: registration.clientRef ?? null, environment: registration.environment, topic: registration.topic, publicKey: registration.publicKey, previews: registration.previews, updatedAt: now },
		});
}

export async function unregisterPushDevice(env: CloudflareEnv, apiKeyId: string): Promise<void> {
	await getDb(env).delete(pushDevices).where(eq(pushDevices.apiKeyId, apiKeyId));
}

/** The APNs JSON for one device: encrypted preview, or content-free when previews are off. */
export async function buildApnsPayload(device: { publicKey: string | null; previews: boolean }, accountId: string, message: NewMessageNotification) {
	const base = { v: 1, accountId, mailboxId: message.mailboxId };
	if (!device.previews || !device.publicKey) {
		return { aps: { alert: { title: "Mailflare", body: "New message" }, "mutable-content": 1, "content-available": 1, sound: "default", "thread-id": message.mailboxId }, mf: base };
	}
	const preview = new TextEncoder().encode(
		JSON.stringify({ from: message.from, fromName: message.fromName, subject: message.subject, messageId: message.messageId }),
	);
	return {
		// Shown only if the extension cannot decrypt in time.
		aps: { alert: { title: "Mailflare", body: "New message" }, "mutable-content": 1, "content-available": 1, sound: "default", "thread-id": message.mailboxId },
		mf: { ...base, enc: await encryptPreview(device.publicKey, preview) },
	};
}

/** Sends a new-message push to every registered device of `userIds`. Expired tokens are dropped. */
export async function sendNativePush(env: CloudflareEnv, userIds: string[], message: NewMessageNotification): Promise<void> {
	if (userIds.length === 0) return;
	const db = getDb(env);
	const devices = await db.select().from(pushDevices).where(inArray(pushDevices.userId, userIds));
	if (devices.length === 0) {
		console.info(`Native push: no registered devices for ${userIds.length} user(s)`);
		return;
	}
	const config = apnsConfig(env);
	const relay = relayBaseUrl(env);
	let apnsToken: string | null = null;
	if (config && devices.some((device) => !isRelayHandle(device.token))) {
		try {
			apnsToken = await providerToken(config);
		} catch (error) {
			console.error("Native push: the APNs key could not be read. Check APNS_PRIVATE_KEY is the full .p8 contents.", error);
		}
	}
	const stale: string[] = [];
	const results = await Promise.allSettled(
		devices.map(async (device) => {
			const payload = await buildApnsPayload(device, device.clientRef ?? device.userId, message);
			const collapseId = message.messageId.slice(0, 64);
			if (isRelayHandle(device.token)) {
				if (!relay) {
					console.warn("Native push skipped: a device registered through a push relay but APNS_RELAY_URL is not set");
					return;
				}
				const result = await sendViaRelay(relay, device.token, payload, collapseId);
				if (result.kind === "sent") console.info(`Push sent through the relay (${device.environment}, topic ${device.topic})`);
				else if (result.kind === "gone") {
					console.warn(`Relay dropped a device (${result.status}, ${device.environment}, topic ${device.topic})`);
					stale.push(device.id);
				} else console.warn(`Relay push ${result.kind} (${result.status}${result.kind === "failed" ? ` ${result.error}` : ""})`);
				return;
			}
			if (!config) {
				console.warn("Native push skipped: no APNS_KEY_ID, APNS_TEAM_ID and APNS_PRIVATE_KEY for a directly registered device");
				return;
			}
			if (!apnsToken) return;
			const host = device.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
			const response = await fetch(`https://${host}/3/device/${device.token}`, {
				method: "POST",
				headers: {
					authorization: `bearer ${apnsToken}`,
					"apns-topic": device.topic,
					"apns-push-type": "alert",
					"apns-priority": "10",
					"apns-collapse-id": collapseId,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
			});
			if (response.ok) {
				console.info(`APNs push sent (${device.environment}, topic ${device.topic})`);
				return;
			}
			const reason = ((await response.json().catch(() => ({}))) as { reason?: string }).reason;
			if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") {
				console.warn(`APNs dropped a device (${response.status} ${reason ?? ""}, ${device.environment}, topic ${device.topic})`);
				stale.push(device.id);
			} else {
				console.warn(`APNs push failed (${response.status} ${reason ?? ""})`);
			}
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") console.error("Native push errored", result.reason);
	}
	if (stale.length) await db.delete(pushDevices).where(inArray(pushDevices.id, stale));
}
