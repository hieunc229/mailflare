import { contactAvatarKeyFor } from "./avatar";
import { avatarPreviewKeyFor } from "@/lib/avatar-images";

const MAX_GRAVATAR_SIZE = 2 * 1024 * 1024;
const ALLOWED_GRAVATAR_TYPES = new Set([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

export async function importGravatarAvatar(
	env: CloudflareEnv,
	userId: string,
	email: string,
): Promise<string | null> {
	try {
		const normalizedEmail = email.trim().toLowerCase();
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(normalizedEmail),
		);
		const hash = Array.from(
			new Uint8Array(digest),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		const response = await fetch(
			`https://gravatar.com/avatar/${hash}?d=404&r=g&s=256`,
			{ signal: AbortSignal.timeout(3000) },
		);
		if (!response.ok) return null;

		const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
		const declaredSize = Number(response.headers.get("Content-Length") ?? 0);
		if (!contentType || !ALLOWED_GRAVATAR_TYPES.has(contentType)) return null;
		if (declaredSize > MAX_GRAVATAR_SIZE) return null;

		const image = await response.arrayBuffer();
		if (image.byteLength > MAX_GRAVATAR_SIZE) return null;

		const key = contactAvatarKeyFor(userId, normalizedEmail);
		await env.BUCKET.put(key, image, { httpMetadata: { contentType } });
		try {
			const previewResponse = await fetch(`https://gravatar.com/avatar/${hash}?d=404&r=g&s=16`, { signal: AbortSignal.timeout(3000) });
			if (previewResponse.ok) {
				const previewType = previewResponse.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
				const preview = await previewResponse.arrayBuffer();
				if (previewType && ALLOWED_GRAVATAR_TYPES.has(previewType) && preview.byteLength <= 32 * 1024) {
					await env.BUCKET.put(avatarPreviewKeyFor(key), preview, { httpMetadata: { contentType: previewType } });
				}
			}
		} catch {
			// The full avatar is still available if the preview request fails.
		}
		return key;
	} catch {
		return null;
	}
}
