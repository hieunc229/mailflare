const TOKEN = "[a-z0-9!#$&^_.+-]+";
const MIME_ESSENCE = new RegExp(`^${TOKEN}/${TOKEN}$`);
const CHARSET_PARAMETER = /;\s*charset\s*=\s*"?([a-z0-9_.:-]+)"?\s*(?:;|$)/i;

/** Types a browser shows without running script, so they may render inline on our origin. */
const INLINE_TYPES = new Set([
	"application/pdf",
	"application/json",
	"text/plain",
	"text/csv",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
]);

/** The lowercase `type/subtype` of a Content-Type value, or null when it is not exactly one well-formed type. */
export function getMimeEssence(contentType: string | null | undefined): string | null {
	// Browsers read a comma-joined value as several types and use the last one, so never guess which one wins.
	if (!contentType || contentType.includes(",")) return null;
	const essence = contentType.split(";", 1)[0].trim().toLowerCase();
	return MIME_ESSENCE.test(essence) ? essence : null;
}

/**
 * The Content-Type to serve a sender- or uploader-supplied file with when it may render inline, or null when it must
 * download. Only the parsed essence is checked and only that is sent back, because echoing the raw value would let
 * `image/svg+xml;charset=utf-8` or `image/png; x=1, text/html` pass a check written against the bare type.
 */
export function getInlineContentType(contentType: string | null | undefined): string | null {
	const essence = getMimeEssence(contentType);
	if (!essence) return null;
	if (!INLINE_TYPES.has(essence) && !essence.startsWith("audio/") && !essence.startsWith("video/")) return null;
	if (!essence.startsWith("text/")) return essence;
	const charset = contentType?.match(CHARSET_PARAMETER)?.[1];
	return charset ? `${essence}; charset=${charset}` : essence;
}
