/** True when `value` (whitespace ignored) is standard base64 that `atob` decodes without throwing. */
export function isValidBase64(value: string): boolean {
	const compact = value.replace(/\s/g, "");
	const match = /^[A-Za-z0-9+/]*(={0,2})$/.exec(compact);
	if (!match) return false;
	return match[1] ? compact.length % 4 === 0 : compact.length % 4 !== 1;
}
