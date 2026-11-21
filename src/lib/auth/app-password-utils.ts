import { parseScopes } from "@/lib/api-keys";

/** An app password, or one of the older JMAP-only keys that did the same job before app passwords existed. */
export function isListedAsAppPassword(key: { kind: string; scopes: string }): boolean {
	if (key.kind === "app") return true;
	const scopes = parseScopes(key.scopes);
	return key.kind === "legacy" && scopes.length === 1 && scopes[0] === "jmap";
}
