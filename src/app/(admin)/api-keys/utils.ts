export function parseApiKeyScopes(scopes: string): string[] {
	try {
		const parsed = JSON.parse(scopes);
		return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
	} catch {
		return [];
	}
}
