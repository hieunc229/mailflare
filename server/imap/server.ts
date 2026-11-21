import { createServer as createPlainServer, type Server as PlainServer, type Socket } from "node:net";
import { createSecureContext, createServer as createTlsServer, type SecureContext, type Server as TlsServer, type TLSSocket } from "node:tls";
import { ipBucket } from "@/lib/auth/app-passwords";
import { DEFAULT_MAX_MESSAGE_SIZE, MAX_APPEND_BUDGET, isLoopbackHost } from "@/lib/imap/config";
import type { CertificateMaterial } from "../runtime/tls-files";
import { ImapConnection, type ConnectionContext } from "./connection";
import { Notifier, type RealtimeSource } from "./notifier";

/**
 * The IMAP listeners: implicit TLS (993) and, when asked, a plain port that must
 * STARTTLS before login. Connections are counted when the TCP connection opens, so a
 * client that never finishes the TLS handshake still uses up its share; the limits are
 * per address (an IPv6 client by its /64, like the login guess budget), per user (after
 * login) and for the whole process.
 */
export type ImapServerOptions = {
	env: CloudflareEnv;
	hostname: string;
	/** Port for implicit TLS, 0 for any free port, null for none. */
	tlsPort: number | null;
	/** Port for STARTTLS, same meaning. */
	starttlsPort: number | null;
	/** Address to bind; by default every interface, IPv6 and IPv4 (IPv4 only where the system has no IPv6). */
	host?: string;
	certificate: CertificateMaterial | null;
	allowPlaintext?: boolean;
	maxConnections?: number;
	maxPerIp?: number;
	maxPerUser?: number;
	failureDelayMs?: number;
	commandsPerSecond?: number;
	/** Most octets the body sections of one FETCH command may add up to. */
	maxFetchBytes?: number;
	/** The largest message one APPEND may carry (APPENDLIMIT). */
	maxMessageSize?: number;
	/** Octets of APPEND data the whole process may hold at once; over that an APPEND is told to try again. */
	appendBudget?: number;
	pollMs?: number;
	timeouts?: ConnectionContext["timeouts"];
	/** The realtime hub, so new mail reaches IDLE clients at once instead of at the next poll. */
	realtime?: RealtimeSource;
};

export const DEFAULT_MAX_PER_IP = 30;
export const DEFAULT_MAX_PER_USER = 20;
export const DEFAULT_MAX_FETCH_BYTES = 128 * 1024 * 1024;
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000;

export class ImapServer {
	readonly notifier: Notifier;
	private readonly connections = new Set<ImapConnection>();
	private readonly byIp = new Map<string, number>();
	private readonly byUser = new Map<string, number>();
	private admitted = 0;
	private appendInFlight = 0;
	private secureContext: SecureContext | null;
	private tlsServer: TlsServer | null = null;
	private plainServer: PlainServer | null = null;
	private stopping = false;
	private readonly allowPlaintext: boolean;
	private readonly maxConnections: number;
	private readonly maxPerIp: number;
	private readonly maxPerUser: number;

	constructor(private readonly options: ImapServerOptions) {
		this.notifier = new Notifier(options.env, options.pollMs, options.realtime);
		this.secureContext = options.certificate ? this.contextFor(options.certificate) : null;
		this.maxConnections = options.maxConnections ?? 500;
		this.maxPerIp = options.maxPerIp ?? DEFAULT_MAX_PER_IP;
		this.maxPerUser = options.maxPerUser ?? DEFAULT_MAX_PER_USER;
		// LOGIN without TLS is for local testing only: it needs the flag and a loopback bind.
		if (options.allowPlaintext && !isLoopbackHost(options.host)) console.warn("IMAP_ALLOW_PLAINTEXT is ignored: the listener is not bound to a loopback address");
		this.allowPlaintext = !!options.allowPlaintext && isLoopbackHost(options.host);
	}

	private contextFor(material: CertificateMaterial): SecureContext {
		return createSecureContext({ key: material.key, cert: material.cert, minVersion: "TLSv1.2" });
	}

	/** Applies a renewed certificate to new connections; open ones keep theirs. */
	reloadCertificate(material: CertificateMaterial): void {
		this.secureContext = this.contextFor(material);
		this.tlsServer?.setSecureContext({ key: material.key, cert: material.cert, minVersion: "TLSv1.2" });
	}

	/** Octets of APPEND data held right now (for tests and the status line). */
	get appendBytesInFlight(): number {
		return this.appendInFlight;
	}

	get connectionCount(): number {
		return this.admitted;
	}

	private context(): ConnectionContext {
		return {
			env: this.options.env,
			hostname: this.options.hostname,
			allowPlaintext: this.allowPlaintext,
			notifier: this.notifier,
			admitUser: (userId) => {
				const count = this.byUser.get(userId) ?? 0;
				if (count >= this.maxPerUser) return false;
				this.byUser.set(userId, count + 1);
				return true;
			},
			releaseUser: (userId) => {
				const count = (this.byUser.get(userId) ?? 1) - 1;
				if (count <= 0) this.byUser.delete(userId);
				else this.byUser.set(userId, count);
			},
			secureContext: () => this.secureContext,
			failureDelayMs: this.options.failureDelayMs ?? 1000,
			commandsPerSecond: this.options.commandsPerSecond ?? 100,
			fetchByteBudget: this.options.maxFetchBytes ?? DEFAULT_MAX_FETCH_BYTES,
			maxMessageSize: Math.min(this.options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE, this.options.appendBudget ?? MAX_APPEND_BUDGET),
			reserveAppend: (bytes) => {
				if (this.appendInFlight + bytes > (this.options.appendBudget ?? MAX_APPEND_BUDGET)) return false;
				this.appendInFlight += bytes;
				return true;
			},
			releaseAppend: (bytes) => {
				this.appendInFlight = Math.max(0, this.appendInFlight - bytes);
			},
			timeouts: this.options.timeouts,
		};
	}

	/** Counts the raw connection; false when a limit is reached. Released when the socket closes. */
	private admit(raw: Socket): boolean {
		const ip = raw.remoteAddress ? ipBucket(raw.remoteAddress) : "unknown";
		const perIp = this.byIp.get(ip) ?? 0;
		if (this.stopping || this.admitted >= this.maxConnections || perIp >= this.maxPerIp) return false;
		this.admitted += 1;
		this.byIp.set(ip, perIp + 1);
		raw.once("close", () => {
			this.admitted -= 1;
			const left = (this.byIp.get(ip) ?? 1) - 1;
			if (left <= 0) this.byIp.delete(ip);
			else this.byIp.set(ip, left);
		});
		raw.setNoDelay(true);
		return true;
	}

	private track(connection: ImapConnection): void {
		this.connections.add(connection);
		void connection.done.then(() => this.connections.delete(connection));
	}

	/** Starts the listeners; resolves with the ports actually bound. */
	async start(): Promise<{ tlsPort: number | null; starttlsPort: number | null }> {
		const { tlsPort, starttlsPort, host } = this.options;
		this.notifier.start();
		let boundTls: number | null = null;
		let boundStarttls: number | null = null;
		if (tlsPort !== null) {
			const certificate = this.options.certificate;
			if (!certificate) throw new Error("IMAP needs a TLS certificate (SMTP_TLS_KEY and SMTP_TLS_CERT)");
			const server = createTlsServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2", handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS });
			this.tlsServer = server;
			const refused = new WeakSet<Socket>();
			server.on("connection", (raw: Socket) => {
				if (!this.admit(raw)) {
					refused.add(raw);
					raw.destroy();
				}
			});
			server.on("secureConnection", (socket: TLSSocket) => {
				if (refused.has(socket)) return socket.destroy();
				this.track(new ImapConnection(socket, this.context(), true));
			});
			server.on("tlsClientError", () => undefined);
			server.on("error", (error) => console.error("IMAP TLS listener error", error));
			boundTls = await this.listen(server, tlsPort, host);
		}
		if (starttlsPort !== null) {
			if (!this.secureContext && !this.allowPlaintext) throw new Error("IMAP STARTTLS needs a TLS certificate (SMTP_TLS_KEY and SMTP_TLS_CERT)");
			const server = createPlainServer((socket) => {
				if (!this.admit(socket)) {
					socket.destroy();
					return;
				}
				this.track(new ImapConnection(socket, this.context(), false));
			});
			server.on("error", (error) => console.error("IMAP STARTTLS listener error", error));
			this.plainServer = server;
			boundStarttls = await this.listen(server, starttlsPort, host);
		}
		return { tlsPort: boundTls, starttlsPort: boundStarttls };
	}

	/** Binds `host`, or with none given `::`, which takes IPv4 as well; where the system has no IPv6 it binds `0.0.0.0` instead. */
	private async listen(server: TlsServer | PlainServer, port: number, host: string | undefined): Promise<number> {
		const bind = (address: string) =>
			new Promise<number>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, address, () => {
					server.off("error", reject);
					resolve((server.address() as { port: number }).port);
				});
			});
		if (host !== undefined) return bind(host);
		try {
			return await bind("::");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") throw error;
			return bind("0.0.0.0");
		}
	}

	/** Stops accepting, says goodbye to every session and waits (briefly) for them to end. */
	async stop(): Promise<void> {
		this.stopping = true;
		this.notifier.stop();
		const closed = [this.tlsServer, this.plainServer].filter((server): server is TlsServer | PlainServer => !!server).map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
		for (const connection of this.connections) connection.shutdown();
		const hardStop = setTimeout(() => {
			for (const connection of this.connections) connection.destroy();
		}, 3000);
		// Sockets still in a TLS handshake are not sessions yet; they end on their own timeout, which is not worth waiting for.
		await Promise.race([Promise.all([...closed, ...[...this.connections].map((connection) => connection.done)]), new Promise((resolve) => setTimeout(resolve, 4000).unref())]);
		clearTimeout(hardStop);
	}
}
