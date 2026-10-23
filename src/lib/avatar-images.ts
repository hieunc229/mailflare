const MAX_STORED_AVATAR_SIZE = 1024 * 1024;
const MAX_PREVIEW_AVATAR_SIZE = 32 * 1024;

export function avatarPreviewKeyFor(key: string): string {
	return `${key}:preview`;
}

export function getOptimizedAvatarFiles(form: FormData): { full: File; preview: File } | null {
	const full = form.get("file");
	const preview = form.get("preview");
	if (!(full instanceof File) || !(preview instanceof File)) return null;
	if (full.type !== "image/webp" || preview.type !== "image/webp") return null;
	if (!full.size || full.size > MAX_STORED_AVATAR_SIZE) return null;
	if (!preview.size || preview.size > MAX_PREVIEW_AVATAR_SIZE) return null;
	return { full, preview };
}

export async function storeAvatarImages(
	bucket: CloudflareEnv["BUCKET"],
	key: string,
	full: File,
	preview: File,
): Promise<void> {
	await bucket.put(avatarPreviewKeyFor(key), await preview.arrayBuffer(), {
		httpMetadata: { contentType: "image/webp" },
	});
	await bucket.put(key, await full.arrayBuffer(), {
		httpMetadata: { contentType: "image/webp" },
	});
}

export async function deleteAvatarImages(bucket: CloudflareEnv["BUCKET"], key: string): Promise<void> {
	await bucket.delete([key, avatarPreviewKeyFor(key)]);
}

export async function getAvatarImageResponse(
	request: Request,
	bucket: CloudflareEnv["BUCKET"],
	key: string,
): Promise<Response> {
	const url = new URL(request.url);
	const imageKey = url.searchParams.get("variant") === "preview" ? avatarPreviewKeyFor(key) : key;
	const object = await bucket.get(imageKey);
	if (!object) return new Response("Not found", { status: 404 });

	const headers = new Headers({
		"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
		// Uploads change the URL's version. Unversioned URLs refresh within five minutes
		// without an authenticated DB/storage round trip on every component remount.
		"Cache-Control": url.searchParams.has("v")
			? "private, max-age=31536000, immutable"
			: "private, max-age=300",
		// The same URL can resolve to different images after switching accounts.
		Vary: "Cookie, Authorization",
		ETag: object.httpEtag,
	});
	if (request.headers.get("If-None-Match") === object.httpEtag) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(object.body, { headers });
}
