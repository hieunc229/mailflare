import { getServerSecret } from "@/lib/security/server-secret";
import type { MessageUndoTokenPayload } from "./types";

// v2 binds the token to the session user and a single-use claim nonce.
const TOKEN_VERSION = 2;
export const MAX_UNDO_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
	try {
		const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
		const binary = atob(padded);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	} catch {
		return null;
	}
}

async function importTokenKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(`message-action-undo\n${secret}`),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/** Signs the exact server-confirmed before/after states, so a client cannot invent an undo. */
export async function signUndoToken(secret: string, payload: MessageUndoTokenPayload): Promise<string> {
	const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign("HMAC", await importTokenKey(secret), new TextEncoder().encode(body));
	return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Returns null for tampered, malformed or expired tokens. */
export async function verifyUndoToken(
	secret: string,
	token: string,
	now = Date.now(),
): Promise<MessageUndoTokenPayload | null> {
	const [body, signature] = token.split(".");
	if (!body || !signature) return null;
	const signatureBytes = base64UrlToBytes(signature);
	if (!signatureBytes) return null;
	const signatureBuffer = new ArrayBuffer(signatureBytes.length);
	new Uint8Array(signatureBuffer).set(signatureBytes);
	const valid = await crypto.subtle.verify(
		"HMAC",
		await importTokenKey(secret),
		signatureBuffer,
		new TextEncoder().encode(body),
	);
	if (!valid) return null;
	const bodyBytes = base64UrlToBytes(body);
	if (!bodyBytes) return null;
	let payload: MessageUndoTokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as MessageUndoTokenPayload;
	} catch {
		return null;
	}
	if (payload?.v !== TOKEN_VERSION || typeof payload.issuedAt !== "number" || !Array.isArray(payload.records)) return null;
	if (typeof payload.userId !== "string" || !payload.userId || typeof payload.nonce !== "string" || !payload.nonce) return null;
	if (payload.issuedAt > now + CLOCK_SKEW_MS || payload.issuedAt < now - MAX_UNDO_AGE_MS) return null;
	return payload;
}

export async function signUndoTokenForEnv(env: CloudflareEnv, payload: MessageUndoTokenPayload): Promise<string> {
	return signUndoToken(await getServerSecret(env), payload);
}

export async function verifyUndoTokenForEnv(
	env: CloudflareEnv,
	token: string,
	now = Date.now(),
): Promise<MessageUndoTokenPayload | null> {
	return verifyUndoToken(await getServerSecret(env), token, now);
}
