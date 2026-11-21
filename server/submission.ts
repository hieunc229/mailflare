import { createServer as createPlainServer, type Server as PlainServer, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from "node:tls";
import { SMTPServer, type SMTPServerAuthentication, type SMTPServerAuthenticationResponse, type SMTPServerAddress, type SMTPServerSession } from "smtp-server";
import type { Readable } from "node:stream";
import { ipBucket } from "@/lib/auth/app-passwords";
import { getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { authenticateSubmission, revalidateIdentity, type ImapIdentity, type LoginFailure } from "@/lib/imap/auth";
import { DEFAULT_SUBMISSION_PER_HOUR, isLoopbackHost } from "@/lib/imap/config";
import { SubmissionLimiter, SubmissionError, authorizeMailFrom, normalizeAddress, submissionSizeLimit, submitMessage, MAX_RECIPIENTS } from "@/lib/imap/submission";
import type { CertificateMaterial } from "./runtime/tls-files";

/**
 * The SMTP submission listeners: STARTTLS (587) and implicit TLS (465), for mail apps that log in with an app
 * password. The protocol (framing, STARTTLS, AUTH, dot-stuffing) is `smtp-server`'s; everything around it is
 * ours: sockets are accepted here so each connection is counted (per address, an IPv6 client by its /64, and for
 * the process) before a byte is read; a connection must log in within a deadline; the data of a message is
 * charged to a process-wide memory budget as it arrives; a client that never reads our answers is dropped; and
 * the key is checked again before each message.
 */
export type SubmissionServerOptions = {
	env: CloudflareEnv;
	hostname: string;
	/** Port for implicit TLS, 0 for any free port, null for none. */
	tlsPort: number | null;
	/** Port for STARTTLS, same meaning. */
	starttlsPort: number | null;
	host?: string;
	certificate: CertificateMaterial | null;
	allowPlaintext?: boolean;
	maxConnections?: number;
	maxPerIp?: number;
	failureDelayMs?: number;
	maxPerHour?: number;
	maxRecipientsPerHour?: number;
	/** The largest message accepted, in octets; the admin's outgoing limit can only lower it. */
	maxSize?: number;
	/** Octets the data of messages being received may add up to across the process. */
	dataBudget?: number;
	/** Unsent answers one connection may have queued before it is dropped. */
	maxPendingOutput?: number;
	outputCheckMs?: number;
	/** How long a connection may take to log in, from the moment it opens. */
	authTimeoutMs?: number;
	/** How often a logged-in connection checks that its key still stands. */
	revalidateMs?: number;
	/** Idle time after which a connection is closed. */
	idleTimeoutMs?: number;
};

export const DEFAULT_MAX_CONNECTIONS = 100;
export const DEFAULT_MAX_PER_IP = 10;
const DEFAULT_DATA_BUDGET = 256 * 1024 * 1024;
const MAX_FAILED_LOGINS = 3;
/** The pause before a failed login is answered, as on IMAP (spec 9.1). */
const DEFAULT_FAILURE_DELAY_MS = 1000;
/** How long a new connection has to log in; once logged in, only the idle timeout applies. */
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;
const TLS_HANDSHAKE_TIMEOUT_MS = 10_000;
const SIZE_REFRESH_MS = 30_000;
const DEFAULT_OUTBOUND_MB = 25;

/** Text that goes into a log line: printable ASCII only. */
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?");

const smtpError = (code: number, message: string) => Object.assign(new Error(message), { responseCode: code });
const fromSubmission = (error: SubmissionError) => smtpError(error.responseCode, error.message);

/**
 * Drops `socket` when more than `limit` octets of our answers wait unsent. Checked on a short timer rather than on
 * every write, which is enough: the answers are a few bytes each and a client that reads even slowly never gets
 * near the limit. Returns a function that stops the watching.
 */
export function watchOutput(socket: Pick<Socket, "writableLength" | "destroy" | "once">, limit: number, everyMs = 1000): () => void {
	const timer = setInterval(() => {
		if (socket.writableLength > limit) socket.destroy();
	}, everyMs);
	timer.unref();
	const stop = () => clearInterval(timer);
	socket.once("close", stop);
	return stop;
}

type Connection = {
	id: string;
	secure: boolean;
	handler_EHLO?: (command: Buffer, callback: () => void) => void;
	_server: { options: { authMethods: string[] } };
};

/**
 * `smtp-server` lists AUTH in its EHLO answer whether or not TLS is on, and refuses it afterwards with 538. A
 * client that is set up without encryption would then send the password in the clear before being told no, so
 * the list is emptied for the EHLO answers given before TLS. If the library changes and the hook is not there,
 * AUTH is simply listed again; it is still refused before TLS.
 */
function hideAuthUntilTls(connection: Connection): void {
	const ehlo = connection.handler_EHLO;
	if (typeof ehlo !== "function") return;
	connection.handler_EHLO = (command, callback) => {
		const options = connection._server.options;
		const methods = options.authMethods;
		if (!connection.secure) options.authMethods = [];
		try {
			ehlo.call(connection, command, callback);
		} finally {
			options.authMethods = methods;
		}
	};
}

/** The longest user name and password AUTH may carry; anything longer cannot belong to an account or an app password. */
const MAX_USERNAME = 320;
const MAX_SECRET = 256;

/** `dropData` gives back the data-budget charge of the message being received, if any; it is safe to call more than once. */
type Guard = { socket: Socket; failures: number; authenticated: boolean; timers: NodeJS.Timeout[]; stops: Array<() => void>; dropData: (() => void) | null; release: () => void };

export class SubmissionServer {
	readonly allowPlaintext: boolean;
	private readonly submit: SMTPServer;
	private readonly implicit: SMTPServer;
	private readonly limiter: SubmissionLimiter;
	private readonly guards = new Map<string, Guard>();
	private readonly byIp = new Map<string, number>();
	private admitted = 0;
	private inFlight = 0;
	private stopping = false;
	private sizeLimit: number;
	private sizeCheckedAt = 0;
	private tlsServer: TlsServer | null = null;
	private plainServer: PlainServer | null = null;
	private readonly maxConnections: number;
	private readonly maxPerIp: number;
	private readonly maxPendingOutput: number;
	private readonly outputCheckMs: number;
	private readonly dataBudget: number;
	private readonly hardSizeCap: number;

	constructor(private readonly options: SubmissionServerOptions) {
		this.limiter = new SubmissionLimiter(options.maxPerHour ?? DEFAULT_SUBMISSION_PER_HOUR, options.maxRecipientsPerHour ?? (options.maxPerHour ?? DEFAULT_SUBMISSION_PER_HOUR) * 5);
		this.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
		this.maxPerIp = options.maxPerIp ?? DEFAULT_MAX_PER_IP;
		this.maxPendingOutput = options.maxPendingOutput ?? 256 * 1024;
		this.outputCheckMs = options.outputCheckMs ?? 1000;
		this.dataBudget = options.dataBudget ?? DEFAULT_DATA_BUDGET;
		this.hardSizeCap = options.maxSize ?? Number.MAX_SAFE_INTEGER;
		this.sizeLimit = Math.min(submissionSizeLimit(DEFAULT_OUTBOUND_MB), this.hardSizeCap);
		// AUTH without TLS is for local testing only: it needs the flag and a loopback bind.
		if (options.allowPlaintext && !isLoopbackHost(options.host)) console.warn("SUBMISSION_ALLOW_PLAINTEXT is ignored: the listener is not bound to a loopback address");
		this.allowPlaintext = !!options.allowPlaintext && isLoopbackHost(options.host);
		// smtp-server's own certificate has a published key and accepts TLS 1.0: both are replaced, never defaulted.
		const tls = options.certificate ? { key: options.certificate.key, cert: options.certificate.cert, minVersion: "TLSv1.2" as const } : {};
		const shared = {
			name: options.hostname,
			// The client's address is used as it is: no PTR lookup (a DNS query per connection, before a byte is read).
			disableReverseLookup: true,
			banner: "Mailflare",
			authMethods: ["PLAIN", "LOGIN"],
			authOptional: false,
			allowInsecureAuth: this.allowPlaintext,
			// Addresses are ASCII (or punycode) all the way to the provider; SMTPUTF8 is not offered.
			hideSMTPUTF8: true,
			size: this.sizeLimit,
			maxCommandLength: 4096,
			maxAllowedUnauthenticatedCommands: 10,
			socketTimeout: options.idleTimeoutMs ?? 5 * 60_000,
			closeTimeout: 3000,
			...tls,
			onConnect: (session: SMTPServerSession, callback: (error?: Error) => void) => void this.onConnect(session, callback),
			onAuth: (auth: SMTPServerAuthentication, session: SMTPServerSession, callback: (error: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void) => void this.onAuth(auth, session, callback),
			onMailFrom: (address: SMTPServerAddress, session: SMTPServerSession, callback: (error?: Error) => void) => void this.onMailFrom(address, session, callback),
			onRcptTo: (address: SMTPServerAddress, session: SMTPServerSession, callback: (error?: Error) => void) => void this.onRcptTo(address, session, callback),
			onData: (stream: Readable, session: SMTPServerSession, callback: (error?: Error | null, message?: string) => void) => void this.onData(stream, session, callback),
			onSecure: (socket: TLSSocket, session: SMTPServerSession, callback: () => void) => {
				this.guards.get(session.id)?.stops.push(watchOutput(socket, this.maxPendingOutput, this.outputCheckMs));
				callback();
			},
			onClose: (session: SMTPServerSession) => this.guards.get(session.id)?.release(),
		};
		this.submit = new SMTPServer({ ...shared, secure: false, disabledCommands: options.certificate ? [] : ["STARTTLS"] });
		this.implicit = new SMTPServer({ ...shared, secure: true, secured: true, disabledCommands: ["STARTTLS"] });
		for (const server of [this.submit, this.implicit]) server.on("error", (error: Error) => console.error("SMTP submission error", error));
	}

	/** Applies a renewed certificate to new connections; open ones keep theirs. */
	reloadCertificate(material: CertificateMaterial): void {
		this.submit.updateSecureContext({ key: material.key, cert: material.cert });
		this.tlsServer?.setSecureContext({ key: material.key, cert: material.cert, minVersion: "TLSv1.2" });
	}

	get connectionCount(): number {
		return this.admitted;
	}

	/** Memory charged to message data being received right now, in octets (for tests and the status line). */
	get dataBytesInFlight(): number {
		return this.inFlight;
	}

	// ---- connections ----

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

	/** Hands an admitted socket to the protocol and starts watching it: the login deadline and the output backlog. */
	private attach(server: SMTPServer, socket: Socket): void {
		(server as unknown as { connect(socket: Socket): void }).connect(socket);
		const connection = [...(server as unknown as { connections: Set<Connection> }).connections].at(-1);
		if (!connection) {
			socket.destroy();
			return;
		}
		const id = connection.id;
		if (server === this.submit && !this.allowPlaintext) hideAuthUntilTls(connection);
		const guard: Guard = {
			socket,
			failures: 0,
			authenticated: false,
			timers: [],
			stops: [watchOutput(socket, this.maxPendingOutput, this.outputCheckMs)],
			dropData: null,
			release: () => {
				guard.dropData?.();
				guard.dropData = null;
				for (const timer of guard.timers) clearTimeout(timer);
				for (const stop of guard.stops) stop();
				this.guards.delete(id);
			},
		};
		const deadline = setTimeout(() => {
			if (!guard.authenticated) socket.destroy();
		}, this.options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
		deadline.unref();
		guard.timers.push(deadline);
		socket.once("close", guard.release);
		this.guards.set(id, guard);
	}

	/** The SIZE limit follows the admin's outgoing limit, which can change while the server runs. */
	private async refreshSize(): Promise<void> {
		const now = Date.now();
		if (now - this.sizeCheckedAt < SIZE_REFRESH_MS) return;
		this.sizeCheckedAt = now;
		let megabytes = DEFAULT_OUTBOUND_MB;
		try {
			megabytes = await getOutboundAttachmentMaxMb(this.options.env);
		} catch (error) {
			console.warn("SMTP submission could not read the outgoing limit; using the default", error);
		}
		this.sizeLimit = Math.min(submissionSizeLimit(megabytes), this.hardSizeCap);
		this.submit.options.size = this.sizeLimit;
		this.implicit.options.size = this.sizeLimit;
	}

	private async onConnect(session: SMTPServerSession, callback: (error?: Error) => void): Promise<void> {
		if (this.stopping) return callback(smtpError(421, "Service shutting down"));
		await this.refreshSize();
		callback();
	}

	// ---- AUTH ----

	private logFailure(session: SMTPServerSession, reason: LoginFailure, username: string): void {
		const ip = session.remoteAddress ? ipBucket(session.remoteAddress) : "unknown";
		console.warn(`SMTP login failed ip=${ip} reason=${reason} user=${JSON.stringify(printable(username).slice(0, 64))}`);
	}

	private async onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, callback: (error: Error | null | undefined, response?: SMTPServerAuthenticationResponse) => void): Promise<void> {
		const guard = this.guards.get(session.id);
		const username = typeof auth.username === "string" ? auth.username : "";
		const secret = typeof auth.password === "string" ? auth.password : "";
		let result;
		try {
			result = !username || !secret || username.length > MAX_USERNAME || secret.length > MAX_SECRET ? ({ ok: false, reason: "malformed" } as const) : await authenticateSubmission(this.options.env, { username, secret, ip: session.remoteAddress || null, client: "SMTP" });
		} catch (error) {
			console.error("SMTP submission login failed to run", error);
			return callback(smtpError(454, "Temporary authentication failure"));
		}
		if (result.ok) {
			if (guard) {
				guard.authenticated = true;
				this.watchKey(guard, result.identity);
			}
			return callback(null, { user: result.identity });
		}
		this.logFailure(session, result.reason, username);
		if (guard) guard.failures += 1;
		const delay = this.options.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS;
		if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
		if (result.reason === "throttled") return callback(smtpError(421, "Too many login attempts; try again later"));
		if (guard && guard.failures >= MAX_FAILED_LOGINS) return callback(smtpError(421, "Too many failed logins"));
		callback(smtpError(535, "Authentication failed"));
	}

	/** An open session whose key is deleted, loses its scope or whose user is disabled is closed within the interval. */
	private watchKey(guard: Guard, identity: ImapIdentity): void {
		const timer = setInterval(() => {
			void revalidateIdentity(this.options.env, identity, "submission").then(
				(still) => {
					if (!still) guard.socket.destroy();
				},
				() => undefined,
			);
		}, this.options.revalidateMs ?? 60_000);
		timer.unref();
		guard.stops.push(() => clearInterval(timer));
	}

	/** The session's login, checked against the database again; null (and the connection told to go) when it no longer stands. */
	private async stillLoggedIn(session: SMTPServerSession): Promise<ImapIdentity | null> {
		const identity = session.user as ImapIdentity | undefined;
		if (!identity?.keyId) return null;
		try {
			const fresh = await revalidateIdentity(this.options.env, identity, "submission");
			if (fresh) (session as { user?: unknown }).user = fresh;
			return fresh;
		} catch (error) {
			console.error("SMTP submission could not re-check a login", error);
			return null;
		}
	}

	// ---- the transaction ----

	private async onMailFrom(address: SMTPServerAddress, session: SMTPServerSession, callback: (error?: Error) => void): Promise<void> {
		const identity = await this.stillLoggedIn(session);
		if (!identity) return callback(smtpError(421, "Credentials revoked"));
		if (!this.limiter.hasRoom(identity.userId)) return callback(smtpError(450, "Sending limit reached, try again later"));
		try {
			await authorizeMailFrom(this.options.env, identity, address.address);
			callback();
		} catch (error) {
			if (error instanceof SubmissionError) return callback(fromSubmission(error));
			console.error("SMTP submission sender check failed", error);
			callback(smtpError(451, "Temporary failure, try again later"));
		}
	}

	private onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, callback: (error?: Error) => void): void {
		if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) return callback(smtpError(452, "Too many recipients"));
		if (!normalizeAddress(address.address)) return callback(smtpError(553, "Recipient address not valid"));
		callback();
	}

	private onData(stream: Readable, session: SMTPServerSession, callback: (error?: Error | null, message?: string) => void): void {
		const chunks: Buffer[] = [];
		let received = 0;
		let charged = 0;
		let busy = false;
		const limit = this.sizeLimit;
		const release = () => {
			this.inFlight -= charged;
			charged = 0;
		};
		// A connection that closes mid-DATA may end the stream with neither "end" nor "error"; closing releases it too.
		const guard = this.guards.get(session.id);
		if (guard) guard.dropData = release;
		stream.on("error", () => release());
		stream.on("data", (chunk: Buffer) => {
			received += chunk.length;
			if (received > limit || busy) {
				// Past the limit (the 552 is sent when the stream ends) or past the budget: nothing more is kept.
				chunks.length = 0;
				release();
				return;
			}
			if (this.inFlight + chunk.length > this.dataBudget) {
				busy = true;
				chunks.length = 0;
				release();
				return;
			}
			this.inFlight += chunk.length;
			charged += chunk.length;
			chunks.push(chunk);
		});
		stream.on("end", async () => {
			try {
				if ((stream as unknown as { sizeExceeded?: boolean }).sizeExceeded || received > limit) return callback(smtpError(552, "Message exceeds size limit"));
				if (busy) return callback(smtpError(452, "Server busy, try again later"));
				const identity = await this.stillLoggedIn(session);
				if (!identity) return callback(smtpError(421, "Credentials revoked"));
				const mailFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
				const recipients = session.envelope.rcptTo.map((recipient) => recipient.address);
				const { messageId } = await submitMessage(this.options.env, identity, { mailFrom, recipients, raw: Buffer.concat(chunks), ip: session.remoteAddress || null }, this.limiter);
				callback(null, `Queued as ${messageId}`);
			} catch (error) {
				if (error instanceof SubmissionError) return callback(fromSubmission(error));
				console.error("SMTP submission failed", error);
				callback(smtpError(451, "Temporary failure, try again later"));
			} finally {
				chunks.length = 0;
				release();
			}
		});
	}

	// ---- listeners ----

	/** Starts the listeners; resolves with the ports actually bound. */
	async start(): Promise<{ tlsPort: number | null; starttlsPort: number | null }> {
		const { tlsPort, starttlsPort, host, certificate } = this.options;
		let boundTls: number | null = null;
		let boundStarttls: number | null = null;
		if (tlsPort !== null) {
			if (!certificate) throw new Error("SMTP submission needs a TLS certificate (SMTP_TLS_KEY and SMTP_TLS_CERT)");
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
				this.attach(this.implicit, socket);
			});
			server.on("tlsClientError", () => undefined);
			server.on("error", (error) => console.error("SMTP submission TLS listener error", error));
			boundTls = await this.listen(server, tlsPort, host);
		}
		if (starttlsPort !== null) {
			if (!certificate && !this.allowPlaintext) throw new Error("SMTP submission STARTTLS needs a TLS certificate (SMTP_TLS_KEY and SMTP_TLS_CERT)");
			const server = createPlainServer((socket) => {
				if (!this.admit(socket)) return void socket.destroy();
				this.attach(this.submit, socket);
			});
			server.on("error", (error) => console.error("SMTP submission STARTTLS listener error", error));
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
		const closed = [this.tlsServer, this.plainServer].filter((server): server is TlsServer | PlainServer => !!server).map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
		const protocols = [this.submit, this.implicit].map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
		const hardStop = setTimeout(() => {
			for (const guard of this.guards.values()) guard.socket.destroy();
		}, 1000);
		await Promise.race([Promise.all([...closed, ...protocols]), new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
		clearTimeout(hardStop);
		for (const guard of [...this.guards.values()]) guard.release();
	}
}
