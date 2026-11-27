/** Which protocol a poller will speak to an external account (F37/F38 own the clients). */
export const EXTERNAL_ACCOUNT_PROTOCOLS = ["imap", "pop3"] as const;

/** implicit-tls dials the TLS port directly (993/995), starttls upgrades a plain connection, none stays plaintext. */
export const EXTERNAL_ACCOUNT_TLS_MODES = ["implicit-tls", "starttls", "none"] as const;

export const DEFAULT_EXTERNAL_ACCOUNT_TLS_MODE = "implicit-tls";
