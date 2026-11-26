import type { TranslationKey } from "@/lib/i18n/types";
import type { AdminApiKeyScope } from "@/lib/api/scopes-types";

export const ADMIN_KEY_PERMISSIONS: { value: AdminApiKeyScope; labelKey: TranslationKey; descriptionKey: TranslationKey }[] = [
	{ value: "domains", labelKey: "adminKeys.perm.domains", descriptionKey: "adminKeys.perm.domainsDesc" },
	{ value: "accounts", labelKey: "adminKeys.perm.accounts", descriptionKey: "adminKeys.perm.accountsDesc" },
	{ value: "mailboxes", labelKey: "adminKeys.perm.mailboxes", descriptionKey: "adminKeys.perm.mailboxesDesc" },
	{ value: "storage", labelKey: "adminKeys.perm.storage", descriptionKey: "adminKeys.perm.storageDesc" },
	{ value: "groups", labelKey: "adminKeys.perm.groups", descriptionKey: "adminKeys.perm.groupsDesc" },
];

export function parseApiKeyScopes(scopes: string): string[] {
	try {
		const parsed = JSON.parse(scopes);
		return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
	} catch {
		return [];
	}
}
