/**
 * A stored credential is encrypted as UTF-8 text, so it must be text that survives the round trip byte for
 * byte. Unpaired UTF-16 surrogates do not: the encoder replaces them with U+FFFD, which would silently change
 * the password the user typed. The API rejects them at validation time (and the crypto helper refuses them
 * again, because a caller other than the route may reach it).
 */
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const UNPAIRED_SURROGATE_MESSAGE = "The value contains an invalid Unicode character";

export function hasUnpairedSurrogate(value: string): boolean {
	return UNPAIRED_SURROGATE.test(value);
}
