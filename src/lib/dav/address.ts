/** The longest e-mail address (RFC 5321 path limit). */
export const MAX_ADDRESS = 320;

const SEPARATORS = '<>",;:';

/**
 * One plain mailbox address: at most 320 characters, exactly one `@` with something on each side, no whitespace or
 * control characters and none of `<>",;:`.
 */
export function isDavAddress(value: string): boolean {
	if (value.length > MAX_ADDRESS) return false;
	const at = value.indexOf("@");
	if (at < 1 || at === value.length - 1 || value.indexOf("@", at + 1) !== -1) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		const blank = code <= 0x20 || (code >= 0x7f && code <= 0xa0) || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
		if (blank || SEPARATORS.includes(value[i])) return false;
	}
	return true;
}
