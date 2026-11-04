import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { pushSubscriptions, sessions } from "@/db/schema";
import type { NewMessageNotification } from "@/lib/realtime/types";

type VapidConfig = {
	publicKey: string;
	privateKey: string;
	subject: string;
};

type PushSubscriptionKeys = {
	p256dh: string;
	auth: string;
};

const encoder = new TextEncoder();
const PUSH_ENDPOINT_HOSTS = new Set([
	"fcm.googleapis.com",
	"push.services.mozilla.com",
	"updates.push.services.mozilla.com",
	"web.push.apple.com",
]);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}
	return output;
}

function decodeBase64Url(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function encodeJson(value: unknown): string {
	return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(keyBytes),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(data)));
}

async function hkdf(
	salt: Uint8Array,
	inputKeyMaterial: Uint8Array,
	info: Uint8Array,
	length: number,
): Promise<Uint8Array> {
	if (length > 32) throw new Error("Web Push HKDF output is too long");
	const prk = await hmacSha256(salt, inputKeyMaterial);
	const block = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
	return block.slice(0, length);
}

function parseVapidConfig(env: CloudflareEnv): VapidConfig | null {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = env.VAPID_PRIVATE_KEY?.trim();
	const subject = env.VAPID_SUBJECT?.trim();
	if (!publicKey || !privateKey || !subject) return null;

	try {
		const publicBytes = decodeBase64Url(publicKey);
		const privateBytes = decodeBase64Url(privateKey);
		const subjectUrl = new URL(subject);
		if (
			publicBytes.length !== 65 ||
			publicBytes[0] !== 4 ||
			privateBytes.length !== 32 ||
			!(["mailto:", "https:"] as string[]).includes(subjectUrl.protocol)
		) {
			return null;
		}
	} catch {
		return null;
	}

	return { publicKey, privateKey, subject };
}

export function getVapidPublicKey(env: CloudflareEnv): string | null {
	return parseVapidConfig(env)?.publicKey ?? null;
}

export function isSupportedPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		if (url.protocol !== "https:") return false;
		return PUSH_ENDPOINT_HOSTS.has(url.hostname) || url.hostname.endsWith(".notify.windows.com");
	} catch {
		return false;
	}
}

export function hasValidPushKeys(keys: PushSubscriptionKeys): boolean {
	try {
		return decodeBase64Url(keys.p256dh).length === 65 && decodeBase64Url(keys.auth).length === 16;
	} catch {
		return false;
	}
}

async function createVapidAuthorization(config: VapidConfig, endpoint: string): Promise<string> {
	const audience = new URL(endpoint).origin;
	const publicBytes = decodeBase64Url(config.publicKey);
	const privateBytes = decodeBase64Url(config.privateKey);
	const signingKey = await crypto.subtle.importKey(
		"jwk",
		{
			kty: "EC",
			crv: "P-256",
			x: encodeBase64Url(publicBytes.slice(1, 33)),
			y: encodeBase64Url(publicBytes.slice(33, 65)),
			d: encodeBase64Url(privateBytes),
			ext: true,
		},
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const unsignedToken = `${encodeJson({ typ: "JWT", alg: "ES256" })}.${encodeJson({
		aud: audience,
		exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
		sub: config.subject,
	})}`;
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			signingKey,
			encoder.encode(unsignedToken),
		),
	);
	return `vapid t=${unsignedToken}.${encodeBase64Url(signature)}, k=${config.publicKey}`;
}

async function encryptPushPayload(keys: PushSubscriptionKeys, payload: string): Promise<Uint8Array> {
	const clientPublicBytes = decodeBase64Url(keys.p256dh);
	const authSecret = decodeBase64Url(keys.auth);
	const clientPublicKey = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(clientPublicBytes),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const serverKeys = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const serverPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: clientPublicKey },
			serverKeys.privateKey,
			256,
		),
	);
	const keyInfo = concatBytes(
		encoder.encode("WebPush: info\0"),
		clientPublicBytes,
		serverPublicBytes,
	);
	const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const contentEncryptionKey = await hkdf(
		salt,
		inputKeyMaterial,
		encoder.encode("Content-Encoding: aes128gcm\0"),
		16,
	);
	const nonce = await hkdf(
		salt,
		inputKeyMaterial,
		encoder.encode("Content-Encoding: nonce\0"),
		12,
	);
	const aesKey = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(contentEncryptionKey),
		"AES-GCM",
		false,
		["encrypt"],
	);
	const plaintext = concatBytes(encoder.encode(payload), new Uint8Array([2]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: toArrayBuffer(nonce) },
			aesKey,
			toArrayBuffer(plaintext),
		),
	);
	const header = new Uint8Array(21 + serverPublicBytes.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096);
	header[20] = serverPublicBytes.length;
	header.set(serverPublicBytes, 21);
	return concatBytes(header, ciphertext);
}

async function sendSubscriptionPush(
	config: VapidConfig,
	subscription: { endpoint: string; p256dh: string; auth: string },
	payload: string,
): Promise<Response> {
	const body = await encryptPushPayload(subscription, payload);
	return fetch(subscription.endpoint, {
		method: "POST",
		headers: {
			Authorization: await createVapidAuthorization(config, subscription.endpoint),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: "86400",
			Urgency: "normal",
		},
		body: toArrayBuffer(body),
	});
}

export type PushContent = {
	title: string;
	body: string;
	tag: string;
	url: string;
};

export async function sendPushNotifications(
	env: CloudflareEnv,
	userIds: string[],
	payload: NewMessageNotification,
): Promise<void> {
	// The display name is whatever the sender typed; always show the real address beside it.
	// eslint-disable-next-line no-control-regex
	const name = (payload.fromName ?? "").replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, "").trim();
	const sender = (name && name.toLowerCase() !== payload.from.toLowerCase() ? `${name.slice(0, 120)} <${payload.from}>` : payload.from).slice(0, 240);
	await sendPushContent(env, userIds, {
		title: (payload.subject || "New email").slice(0, 180),
		body: `From ${sender}`,
		tag: payload.messageId,
		url: `/inbox/${payload.messageId}`,
	});
}

/** Delivers an arbitrary notification (title, body, tag, in-app url) to every live Web Push subscription of the users. */
export async function sendPushContent(
	env: CloudflareEnv,
	userIds: string[],
	content: PushContent,
): Promise<void> {
	const config = parseVapidConfig(env);
	const uniqueUserIds = [...new Set(userIds)];
	if (!config || uniqueUserIds.length === 0) return;

	const db = getDb(env);
	const subscriptions = await db
		.select({
			id: pushSubscriptions.id,
			endpoint: pushSubscriptions.endpoint,
			p256dh: pushSubscriptions.p256dh,
			auth: pushSubscriptions.auth,
		})
		.from(pushSubscriptions)
		.innerJoin(sessions, eq(pushSubscriptions.sessionId, sessions.id))
		.where(
			and(
				inArray(pushSubscriptions.userId, uniqueUserIds),
				gt(sessions.expiresAt, new Date()),
			),
		);

	const notificationPayload = JSON.stringify({
		...content,
		icon: "/icon-192.png",
		badge: "/icon-96.png",
	});

	await Promise.allSettled(
		subscriptions.map(async (subscription) => {
			if (!isSupportedPushEndpoint(subscription.endpoint)) return;
			try {
				const response = await sendSubscriptionPush(config, subscription, notificationPayload);
				if (response.status === 404 || response.status === 410) {
					await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
				} else if (!response.ok) {
					console.warn(`Web Push delivery failed (${response.status}) for subscription ${subscription.id}`);
				}
			} catch (error) {
				console.warn(`Web Push delivery failed for subscription ${subscription.id}`, error);
			}
		}),
	);
}
