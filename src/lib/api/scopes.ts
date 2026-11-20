/**
 * Scopes an API key can be granted. Kept free of server-only imports so the
 * dashboard's key-creation form can import it without pulling in bcrypt.
 * Administrative scopes are issued separately from personal mail keys.
 */
export const API_KEY_SCOPES = ["send", "read", "jmap", "calendar:read", "calendar:write"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const ADMIN_API_KEY_SCOPES = ["domains", "accounts", "mailboxes", "storage"] as const;

/**
 * What an app password (`api_keys.kind = 'app'`) can be limited to. Kept apart from
 * `API_KEY_SCOPES` so a general API key can never carry `dav`, `imap` or `submission`
 * (`dav` is CalDAV and CardDAV together).
 */
export const APP_PASSWORD_PROTOCOLS = ["jmap", "dav", "imap", "submission"] as const;

export type AppPasswordScope = (typeof APP_PASSWORD_PROTOCOLS)[number];
