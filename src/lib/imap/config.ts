/**
 * IMAP listener settings, read from the process environment (Docker/Node only).
 * Shared by the server entry point and by the app-password page, which offers the
 * `imap` protocol only when a listener can actually start.
 */
export type ImapConfig = {
	enabled: boolean;
	/** Implicit TLS port; 0 disables it. */
	port: number;
	/** Plain port that requires STARTTLS before login; 0 (the default) disables it. */
	starttlsPort: number;
	host: string | undefined;
	hostname: string | undefined;
	maxConnections: number;
	/** LOGIN without TLS, honoured only when the listener is bound to a loopback address. */
	allowPlaintext: boolean;
	hasCertificate: boolean;
};

type Source = Record<string, string | undefined>;

const port = (value: string | undefined, fallback: number) => {
	const parsed = Number(value?.trim() === "" ? undefined : value);
	return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback;
};

export function readImapConfig(source: Source): ImapConfig {
	const maxConnections = Number(source.IMAP_MAX_CONNECTIONS);
	return {
		enabled: source.IMAP_ENABLED?.trim() === "1",
		port: port(source.IMAP_PORT, 993),
		starttlsPort: port(source.IMAP_STARTTLS_PORT, 0),
		host: source.IMAP_HOST?.trim() || undefined,
		hostname: source.MAIL_HOSTNAME?.trim() || undefined,
		maxConnections: Number.isInteger(maxConnections) && maxConnections > 0 ? maxConnections : 500,
		allowPlaintext: source.IMAP_ALLOW_PLAINTEXT?.trim() === "1",
		hasCertificate: !!(source.SMTP_TLS_KEY?.trim() && source.SMTP_TLS_CERT?.trim()),
	};
}

/** Whether a listener bound to this address is only reachable from the machine itself (no address means every interface). */
export const isLoopbackHost = (host: string | undefined) => !!host && (host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127."));

/**
 * Whether a mail app could log in: the flag is on and every configured listener can start, as the
 * server decides it. The TLS port needs a certificate; the STARTTLS port needs a certificate or the
 * plain test mode, which only works for a loopback bind.
 */
export function imapIsOffered(source: Source): boolean {
	const config = readImapConfig(source);
	if (!config.enabled || (config.port === 0 && config.starttlsPort === 0)) return false;
	const plainOk = config.allowPlaintext && isLoopbackHost(config.host);
	return (config.port === 0 || config.hasCertificate) && (config.starttlsPort === 0 || config.hasCertificate || plainOk);
}
