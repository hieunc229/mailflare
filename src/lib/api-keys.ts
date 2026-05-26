import bcrypt from "bcryptjs";
import { newId } from "@/lib/ids";

const KEY_PREFIX = "ep_";

export function generateApiKey(): { fullKey: string; prefix: string; hash: string } {
	const secret = newId();
	const fullKey = `${KEY_PREFIX}${secret}`;
	const prefix = fullKey.slice(0, 12);
	const hash = bcrypt.hashSync(fullKey, 10);
	return { fullKey, prefix, hash };
}

export function verifyApiKey(fullKey: string, hash: string): boolean {
	return bcrypt.compareSync(fullKey, hash);
}

export function parseScopes(scopesJson: string): string[] {
	try {
		const parsed = JSON.parse(scopesJson) as unknown;
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

export function scopesToJson(scopes: string[]): string {
	return JSON.stringify(scopes);
}
