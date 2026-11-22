/**
 * Scopes an API key can be granted. Kept free of server-only imports so the
 * dashboard's key-creation form can import it without pulling in bcrypt.
 * Administrative scopes are issued separately from personal mail keys.
 */
export const API_KEY_SCOPES = ["send", "read", "jmap", "calendar:read", "calendar:write", "labels:write"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const ADMIN_API_KEY_SCOPES = ["domains", "accounts", "mailboxes", "storage"] as const;
