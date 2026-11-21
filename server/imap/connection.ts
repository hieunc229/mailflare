import type { Socket } from "node:net";
import { TLSSocket, type SecureContext } from "node:tls";
import imapHandler from "imap-handler";
import type { ParsedCommand } from "imap-handler";
import { ipBucket } from "@/lib/auth/app-passwords";
import { authenticateImap, revalidateIdentity, type ImapIdentity, type LoginFailure } from "@/lib/imap/auth";
import { ImapError, bad } from "@/lib/imap/errors";
import { canStillSee, loadNamespace, type Namespace } from "@/lib/imap/namespace";
import type { FolderView } from "@/lib/imap/view";
import { runFetch, sendFlags } from "./commands/fetch";
import { runList, runNamespace, runSelect, runStatus } from "./commands/mailbox";
import { runAppend } from "./commands/append";
import { runCreate, runDelete, runRename, runSubscribe } from "./commands/folders";
import { runStore } from "./commands/store";
import { closeExpunge, runCopy, runExpunge, runMove } from "./commands/transfer";
import { runSearch } from "./commands/search";
import { AUTH_LIMITS, Framer, PRE_AUTH_LIMITS, tagOf } from "./framing";
import type { Notifier } from "./notifier";

/**
 * One IMAP connection: framing, the state machine (not authenticated, authenticated,
 * selected), the response writer, and every limit that applies to a client that may
 * not have proven who it is. Commands run one at a time, in the order they arrived.
 */
export type ConnectionContext = {
	env: CloudflareEnv;
	hostname: string;
	/** LOGIN over a connection that is not encrypted, honoured only for a loopback bind. */
	allowPlaintext: boolean;
	notifier: Notifier;
	/** Admits a logged-in user, or false when the user already has the most connections allowed. */
	admitUser: (userId: string) => boolean;
	releaseUser: (userId: string) => void;
	secureContext: () => SecureContext | null;
	/** Pause after a failed login, so guessing is slow even before the shared limit is spent. */
	failureDelayMs: number;
	commandsPerSecond: number;
	/** The most octets the body sections of one FETCH may add up to. */
	fetchByteBudget: number;
	/** The largest message an APPEND may carry. */
	maxMessageSize: number;
	/** Takes octets from the process-wide budget of in-flight APPEND data; false when it is spent. */
	reserveAppend: (bytes: number) => boolean;
	releaseAppend: (bytes: number) => void;
	/** Overrides of the timers below, for tests. */
	timeouts?: Partial<{ preAuthIdleMs: number; authIdleMs: number; loginDeadlineMs: number; revalidateMs: number; writeStallMs: number }>;
};

export const PRE_AUTH_IDLE_MS = 60_000;
export const AUTH_IDLE_MS = 30 * 60_000;
/** Login must be finished this long after the connection opened, however slowly the client sends. */
export const LOGIN_DEADLINE_MS = 120_000;
/** A client that does not read for this long while we have output waiting is dropped. */
export const WRITE_STALL_MS = 5 * 60_000;
/** The next command waits while more than this much output is queued for the socket. */
export const WRITE_QUEUE_LIMIT = 1024 * 1024;
export const REVALIDATE_MS = 60_000;
const MAX_FAILED_LOGINS = 5;
/** Refusals of oversize input in a row (no command in between) after which the connection ends. */
const MAX_CONSECUTIVE_REJECTS = 5;

export type SelectedFolder = {
	view: FolderView;
	mailboxId: string;
	/** The name the client selected, kept to answer in kind. */
	name: string;
	/** EXAMINE, or a mailbox this login may only read. */
	readOnly: boolean;
	unwatch: () => void;
};

type Phase = "notauth" | "auth" | "selected" | "logout";

/** `skipResponse`: the command already wrote its own tagged response (STARTTLS must, before the handshake). */
export type Completion = { code?: string; text?: string; skipResponse?: boolean } | void;

const binary = (text: string) => Buffer.from(text, "latin1");
/** Text that goes into a response line: printable ASCII only. */
const printable = (text: string) => text.replace(/[^\x20-\x7e]/g, "?");

export class ImapConnection {
	phase: Phase = "notauth";
	identity: ImapIdentity | null = null;
	selected: SelectedFolder | null = null;
	/** The IMAP ID name the client gave, for the login audit entry. */
	clientName = "IMAP";
	readonly remoteAddress: string | null;
	private socket: Socket | TLSSocket;
	private readonly framer = new Framer(PRE_AUTH_LIMITS);
	private encrypted: boolean;
	private closed = false;
	private closing = false;
	private idleTimer: NodeJS.Timeout | null = null;
	private deadlineTimer: NodeJS.Timeout | null = null;
	private revalidateTimer: NodeJS.Timeout | null = null;
	private wake: (() => void) | null = null;
	private paused = false;
	private failedLogins = 0;
	private consecutiveRejects = 0;
	private tokens: number;
	private lastRefill = Date.now();
	private idleUpdate = false;
	private endAfterResponse = false;
	private ended = false;
	/** Updates the notifier found while a command ran; sent before the next tagged response that may carry them. */
	dirty = false;
	idling = false;
	readonly done: Promise<void>;
	private finish!: () => void;

	constructor(socket: Socket | TLSSocket, private readonly context: ConnectionContext, encrypted: boolean) {
		this.socket = socket;
		this.encrypted = encrypted;
		this.remoteAddress = socket.remoteAddress ?? null;
		this.tokens = context.commandsPerSecond;
		this.framer.reserve = context.reserveAppend;
		this.framer.release = context.releaseAppend;
		this.done = new Promise((resolve) => (this.finish = resolve));
		this.attach(socket);
		this.deadlineTimer = setTimeout(() => void this.bye("Login timed out"), context.timeouts?.loginDeadlineMs ?? LOGIN_DEADLINE_MS);
		this.armIdle();
		void this.run();
	}

	get env(): CloudflareEnv {
		return this.context.env;
	}
	get notifier(): Notifier {
		return this.context.notifier;
	}
	get fetchByteBudget(): number {
		return this.context.fetchByteBudget;
	}
	get isClosed(): boolean {
		return this.closed;
	}
	get isEncrypted(): boolean {
		return this.encrypted;
	}

	// ---- Socket plumbing ----

	private attach(socket: Socket | TLSSocket): void {
		socket.on("data", (chunk: Buffer) => {
			if (this.closed) return;
			this.armIdle();
			this.framer.push(chunk);
			if (this.framer.buffered > this.framer.backlogLimit && !this.paused) {
				this.paused = true;
				socket.pause();
			}
			this.signal();
		});
		socket.on("error", () => this.destroy());
		socket.on("close", () => this.destroy());
		socket.on("end", () => this.signal());
	}

	private signal(): void {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}

	/** Resolves when something happens: bytes arrive, an update is pushed, the connection ends. */
	private waitForSignal(): Promise<void> {
		return new Promise((resolve) => {
			this.wake = resolve;
		});
	}

	private armIdle(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.bye("Autologout; idle for too long"), this.phase === "notauth" ? (this.context.timeouts?.preAuthIdleMs ?? PRE_AUTH_IDLE_MS) : (this.context.timeouts?.authIdleMs ?? AUTH_IDLE_MS));
	}

	destroy(): void {
		if (this.closed) return;
		this.closed = true;
		for (const timer of [this.idleTimer, this.deadlineTimer, this.revalidateTimer]) if (timer) clearTimeout(timer);
		if (this.revalidateTimer) clearInterval(this.revalidateTimer);
		this.deselect();
		this.framer.dispose();
		if (this.identity) this.context.releaseUser(this.identity.userId);
		this.identity = null;
		this.socket.destroy();
		this.signal();
		this.finish();
	}

	/**
	 * Says goodbye. Called from a timer or the server it closes the connection at once; called
	 * from a command (`endNow` false) the command's own tagged response still follows, and the
	 * connection closes right after it.
	 */
	async bye(text: string, endNow = true): Promise<void> {
		if (this.closed || this.closing) return;
		this.closing = true;
		try {
			this.socket.write(binary(`* BYE ${printable(text)}\r\n`));
		} catch {
			// The socket is already gone.
		}
		if (endNow) this.finishClosing();
		this.signal();
	}

	private finishClosing(): void {
		if (this.closed || this.ended) return;
		this.ended = true;
		this.socket.end();
		setTimeout(() => this.destroy(), 1000).unref();
	}

	/** Server shutdown: say goodbye now, whatever the connection is doing. */
	shutdown(): void {
		void this.bye("Server shutting down");
	}

	// ---- Output ----

	send(line: string): void {
		if (this.closed || this.ended) return;
		this.socket.write(binary(`${line}\r\n`));
	}

	untagged(text: string): void {
		this.send(`* ${text}`);
	}

	compile(node: Parameters<typeof imapHandler.compiler>[0]): string {
		return imapHandler.compiler(node);
	}

	/** Writes bytes and waits for the client to take them, so a large FETCH never queues more than a few chunks in memory. */
	async write(data: Buffer): Promise<void> {
		if (this.closed) return;
		if (this.socket.write(data)) return;
		await this.drained();
	}

	/**
	 * Waits until the socket has taken what is queued for it, and closes the connection when the
	 * client does not read for `WRITE_STALL_MS`. Every response line (`send`, `untagged`) only
	 * queues, so the main loop calls this before each command: whatever one command writes is
	 * bounded by that command, and a client that stops reading stops being served.
	 */
	private async drained(): Promise<void> {
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(stall);
				this.socket.off("drain", done);
				this.socket.off("close", done);
				resolve();
			};
			const stall = setTimeout(() => {
				this.destroy();
				done();
			}, this.context.timeouts?.writeStallMs ?? WRITE_STALL_MS);
			this.socket.once("drain", done);
			this.socket.once("close", done);
		});
	}

	/** Before an answer the client did not ask a command for: waits for the output queue and takes a token; false when the connection is going away. */
	private async pace(): Promise<boolean> {
		await this.waitForOutput();
		if (this.closed || this.closing) return false;
		await this.takeToken();
		return !this.closed && !this.closing;
	}

	/** Holds the caller while more than `WRITE_QUEUE_LIMIT` bytes of output wait for the client. */
	private async waitForOutput(): Promise<void> {
		while (!this.closed && this.socket.writableLength > WRITE_QUEUE_LIMIT) await this.drained();
	}

	// ---- Main loop ----

	private greeting(): string {
		return `* OK [CAPABILITY ${this.capabilities().join(" ")}] ${printable(this.context.hostname)} Mailflare IMAP ready`;
	}

	/** The login mechanisms are only offered where a password may travel: over TLS, or loopback test mode. */
	private loginAllowed(): boolean {
		return this.encrypted || this.context.allowPlaintext;
	}

	capabilities(): string[] {
		const base = ["IMAP4rev1", "SASL-IR", "LITERAL+", "ID", "ENABLE"];
		if (this.phase === "notauth") {
			if (this.loginAllowed()) base.push("AUTH=PLAIN");
			else base.push("STARTTLS", "LOGINDISABLED");
			return base;
		}
		return [...base, "IDLE", "NAMESPACE", "UIDPLUS", "MOVE", `APPENDLIMIT=${this.context.maxMessageSize}`, "UNSELECT", "CHILDREN", "SPECIAL-USE", "LIST-EXTENDED", "LIST-STATUS", "ESEARCH"];
	}

	private async run(): Promise<void> {
		this.send(this.greeting());
		try {
			while (!this.closed) {
				if (this.framer.overflowed) return void (await this.bye("Too many commands queued"));
				const event = this.framer.next();
				if (this.paused && this.framer.buffered < this.framer.backlogLimit / 4) {
					this.paused = false;
					this.socket.resume();
				}
				if (!event) {
					await this.waitForSignal();
					continue;
				}
				if (event.type === "continue") {
					if (!(await this.pace())) return;
					this.send("+ Ready");
					continue;
				}
				if (event.type === "reject") {
					// A refusal is an answer like any other: it waits for the client to read, uses a token, and a run of them ends the connection.
					if (!(await this.pace())) return;
					if (event.code === "append-size" || event.code === "append-busy") {
						// The message is refused (and its bytes already being thrown away); the connection stays usable.
						this.send(event.code === "append-size" ? `${event.tag} NO [TOOBIG] The message is larger than this server accepts` : `${event.tag} NO [LIMIT] Server busy, try again`);
						this.consecutiveRejects += 1;
						if (this.consecutiveRejects >= MAX_CONSECUTIVE_REJECTS) return void (await this.bye("Too many refused messages"));
						continue;
					}
					const text = event.code === "line" ? "Command line too long" : event.code === "literal" ? "Literal too large" : "Command too large";
					this.send(`${event.tag} BAD [TOOBIG] ${text}`);
					this.consecutiveRejects += 1;
					if (event.close || this.consecutiveRejects >= MAX_CONSECUTIVE_REJECTS) return void (await this.bye(text));
					continue;
				}
				this.consecutiveRejects = 0;
				await this.waitForOutput();
				if (this.closed) return;
				await this.execute(event.text, event.body, event.reserved);
				if (this.closing) return;
			}
		} catch (error) {
			console.error("IMAP connection failed", error);
			this.destroy();
		}
	}

	private async takeToken(): Promise<void> {
		const now = Date.now();
		const rate = this.context.commandsPerSecond;
		this.tokens = Math.min(rate, this.tokens + ((now - this.lastRefill) / 1000) * rate);
		this.lastRefill = now;
		if (this.tokens >= 1) {
			this.tokens -= 1;
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.ceil(((1 - this.tokens) / rate) * 1000)));
		this.tokens = 0;
		this.lastRefill = Date.now();
	}

	private async execute(text: string, body?: Buffer, reserved = 0): Promise<void> {
		try {
			await this.executeCommand(text, body);
		} finally {
			// The budget held for an APPEND's bytes is returned however the command ended.
			if (reserved) this.context.releaseAppend(reserved);
		}
	}

	private async executeCommand(text: string, body?: Buffer): Promise<void> {
		await this.takeToken();
		let command: ParsedCommand;
		try {
			command = imapHandler.parser(text, { literalPlus: true });
		} catch {
			this.send(`${tagOf(text)} BAD Could not parse the command`);
			return;
		}
		const tag = command.tag;
		const name = command.command.toUpperCase();
		try {
			const completion = await this.dispatch(name, command, body);
			if (this.closed || this.ended) return;
			if (completion?.skipResponse) return;
			if (!this.endAfterResponse && !this.closing) await this.flushBeforeResponse(name);
			const code = completion?.code ? `[${completion.code}] ` : "";
			this.send(`${tag} OK ${code}${completion?.text ?? `${name} completed`}`);
			if (this.endAfterResponse) this.closing = true;
		} catch (error) {
			if (this.closed || this.ended) return;
			if (error instanceof ImapError) this.send(`${tag} ${error.status} ${error.code ? `[${error.code}] ` : ""}${error.message}`);
			else {
				console.error(`IMAP ${name} failed`, error);
				this.send(`${tag} NO [SERVERBUG] Internal error`);
			}
		}
		if (this.closing) this.finishClosing();
	}

	// ---- Dispatch ----

	private async dispatch(name: string, command: ParsedCommand, body?: Buffer): Promise<Completion> {
		const uid = name === "UID" || name.startsWith("UID ");
		const base = uid ? name.slice(4) : name;
		if (this.phase === "notauth") {
			if (name.startsWith("AUTHENTICATE")) return this.authenticate(command, name);
			switch (name) {
				case "CAPABILITY": return this.capability();
				case "NOOP": return;
				case "LOGOUT": return this.logout();
				case "STARTTLS": return this.startTls(command);
				case "LOGIN": return this.login(command);
				case "ID": return this.id(command);
				default: throw this.refusedCommand(name);
			}
		}
		if (name === "LOGIN" || name.startsWith("AUTHENTICATE") || name === "STARTTLS") throw bad("Already logged in");
		switch (base) {
			case "CAPABILITY": return this.capability();
			case "NOOP": case "CHECK": return this.noop(base === "CHECK");
			case "LOGOUT": return this.logout();
			case "ID": return this.id(command);
			case "ENABLE": return this.enable(command);
			case "NAMESPACE": return runNamespace(this);
			case "LIST": return runList(this, command, "LIST");
			case "LSUB": return runList(this, command, "LSUB");
			case "SUBSCRIBE": case "UNSUBSCRIBE": return runSubscribe(command);
			case "STATUS": return runStatus(this, command);
			case "SELECT": return runSelect(this, command, false);
			case "EXAMINE": return runSelect(this, command, true);
			case "CLOSE": case "UNSELECT": return this.unselect(base);
			case "IDLE": return this.idle();
			case "FETCH": return this.inSelected(() => runFetch(this, command, uid));
			case "SEARCH": return this.inSelected(() => runSearch(this, command, uid));
			case "STORE": return this.inSelected(() => runStore(this, command, uid));
			case "COPY": return this.inSelected(() => runCopy(this, command, uid));
			case "MOVE": return this.inSelected(() => runMove(this, command, uid));
			case "EXPUNGE": return this.inSelected(() => runExpunge(this, command, uid));
			case "APPEND": return runAppend(this, command, body);
			case "CREATE": return runCreate(this, command);
			case "DELETE": return runDelete(this, command);
			case "RENAME": return runRename(this, command);
			default: throw this.refusedCommand(name);
		}
	}

	private refusedCommand(name: string): ImapError {
		return bad(this.phase === "notauth" && ["LIST", "LSUB", "SELECT", "EXAMINE", "STATUS", "FETCH", "SEARCH", "UID FETCH", "UID SEARCH", "IDLE", "NAMESPACE", "CLOSE", "UNSELECT", "CHECK", "STORE", "COPY", "MOVE", "EXPUNGE", "APPEND", "CREATE", "DELETE", "RENAME", "SUBSCRIBE", "UNSUBSCRIBE"].includes(name) ? "Log in first" : "Unknown command");
	}

	private async inSelected(run: () => Promise<Completion>): Promise<Completion> {
		if (!this.selected) throw bad("No mailbox is selected");
		await this.requireAccess();
		return run();
	}

	private capability(): Completion {
		this.untagged(`CAPABILITY ${this.capabilities().join(" ")}`);
	}

	// ---- Updates ----

	private async flushBeforeResponse(name: string): Promise<void> {
		// FETCH, STORE and SEARCH never see sequence numbers change under them (RFC 3501 section 7.4.1).
		const base = name.startsWith("UID ") ? name.slice(4) : name;
		if (!this.selected || ["FETCH", "STORE", "SEARCH", "NOOP", "CHECK", "SELECT", "EXAMINE", "IDLE"].includes(base)) return;
		if (this.dirty) await this.pushUpdates();
	}

	/** Brings the selected folder up to date and tells the client what changed. */
	async pushUpdates(): Promise<void> {
		const selected = this.selected;
		if (!selected) return;
		this.dirty = false;
		const update = await selected.view.refresh();
		if (update.uidvalidityChanged) return void (await this.bye("The mailbox was reset; select it again", false));
		for (const msn of update.expunged) this.untagged(`${msn} EXPUNGE`);
		if (update.exists !== null) {
			this.untagged(`${update.exists} EXISTS`);
			this.untagged("0 RECENT");
		}
		if (update.flagged.length) await sendFlags(this, update.flagged);
	}

	private async noop(check: boolean): Promise<Completion> {
		if (check && !this.selected) throw bad("No mailbox is selected");
		if (this.selected) {
			await this.requireAccess();
			await this.pushUpdates();
		}
		return check ? { text: "CHECK completed" } : { text: "NOOP completed" };
	}

	// ---- Session end and mailbox state ----

	private logout(): Completion {
		this.phase = "logout";
		this.untagged("BYE Logging out");
		this.endAfterResponse = true;
		return { text: "LOGOUT completed" };
	}

	deselect(): void {
		this.selected?.unwatch();
		this.selected = null;
		if (this.phase === "selected") this.phase = "auth";
	}

	private async unselect(command: string): Promise<Completion> {
		if (!this.selected) throw bad("No mailbox is selected");
		// CLOSE removes what is flagged \Deleted (a read-only session has nothing to remove); UNSELECT does not.
		if (command === "CLOSE") await closeExpunge(this);
		this.deselect();
		return { text: `${command} completed` };
	}

	select(selected: SelectedFolder): void {
		this.deselect();
		this.selected = selected;
		this.phase = "selected";
	}

	/** Every command that reads mail first makes sure the user may still read this mailbox. */
	async requireAccess(): Promise<void> {
		const selected = this.selected;
		if (!selected || !this.identity) return;
		if (!(await canStillSee(this.env, this.identity, selected.mailboxId))) {
			await this.bye("Access to this mailbox was removed", false);
			throw new ImapError("NO", "Access to this mailbox was removed");
		}
	}

	/**
	 * Before any command that changes mail: the session must have selected the folder read-write, and
	 * the login's permission on the mailbox is read again, so a delegation lowered to read-only
	 * mid-session stops writes at once.
	 */
	async requireWritable(): Promise<void> {
		const selected = this.selected;
		if (!selected || selected.readOnly) throw new ImapError("NO", "The mailbox is read-only", "NOPERM");
		await this.requireMailboxWritable(selected.mailboxId);
	}

	async requireMailboxWritable(mailboxId: string): Promise<void> {
		const mailbox = (await this.namespace()).mailboxes.find((entry) => entry.id === mailboxId);
		if (!mailbox || mailbox.permission === "read_only") throw new ImapError("NO", "The mailbox is read-only", "NOPERM");
	}

	/** The key row and the user are read again: a revoked app password ends the session. */
	async checkCredentials(inCommand = false): Promise<boolean> {
		if (!this.identity) return false;
		let current: ImapIdentity | null;
		try {
			current = await revalidateIdentity(this.env, this.identity);
		} catch (error) {
			// A login that cannot be confirmed is not kept alive.
			console.warn("IMAP credential check failed", error);
			await this.bye("Credentials could not be checked", !inCommand);
			return false;
		}
		if (!current) {
			await this.bye("Credentials revoked", !inCommand);
			return false;
		}
		this.identity = current;
		return true;
	}

	/** The mailbox access list of this login, loaded for one command. */
	async namespace(): Promise<Namespace> {
		const namespace = this.identity ? await loadNamespace(this.env, this.identity) : null;
		if (!namespace) {
			await this.bye("Access to this mailbox was removed", false);
			throw new ImapError("NO", "Access to this mailbox was removed");
		}
		return namespace;
	}

	// ---- Commands of this file ----

	private id(command: ParsedCommand): Completion {
		const list = command.attributes?.[0];
		if (list !== null && !Array.isArray(list)) throw bad("ID takes a list or NIL");
		if (Array.isArray(list)) {
			if (list.length > 60 || list.length % 2 !== 0) throw bad("Too many ID fields");
			const fields = new Map<string, string>();
			for (let at = 0; at < list.length; at += 2) {
				const key = list[at] as { value?: unknown } | null;
				const value = list[at + 1] as { value?: unknown } | null;
				if (!key || typeof key.value !== "string" || key.value.length > 30) throw bad("An ID field name is not valid");
				if (value && (typeof value.value !== "string" || value.value.length > 1024)) throw bad("An ID field value is not valid");
				fields.set(key.value.toLowerCase(), typeof value?.value === "string" ? value.value : "");
			}
			const name = fields.get("name");
			if (name) this.clientName = printable(name).slice(0, 64);
		}
		this.untagged('ID ("name" "Mailflare" "vendor" "Mailflare")');
	}

	private enable(command: ParsedCommand): Completion {
		for (const attribute of command.attributes ?? []) if (Array.isArray(attribute)) throw bad("ENABLE takes capability names");
		// No extension that ENABLE switches on is offered yet, so nothing is enabled.
		this.untagged("ENABLED");
	}

	private async startTls(command: ParsedCommand): Promise<Completion> {
		if (command.attributes?.length) throw bad("STARTTLS takes no arguments");
		if (this.encrypted) throw bad("TLS is already active");
		const secureContext = this.context.secureContext();
		if (!secureContext) throw new ImapError("NO", "TLS is not available", "UNAVAILABLE");
		// Anything the client sent after STARTTLS was sent in the clear and must never be read as a command.
		if (this.framer.buffered > 0) {
			await this.bye("Data after STARTTLS", false);
			throw new ImapError("BAD", "Data after STARTTLS");
		}
		// The answer and the switch to TLS happen in one step, so no byte of the handshake is read as a command.
		const plain = this.socket;
		plain.write(binary(`${command.tag} OK Begin TLS negotiation now\r\n`));
		plain.removeAllListeners("data");
		plain.removeAllListeners("error");
		plain.removeAllListeners("close");
		plain.removeAllListeners("end");
		const secure = new TLSSocket(plain, { isServer: true, secureContext } as ConstructorParameters<typeof TLSSocket>[1]);
		plain.on("error", () => this.destroy());
		plain.on("close", () => this.destroy());
		secure.setTimeout(10_000, () => secure.destroy());
		secure.once("secure", () => secure.setTimeout(0));
		this.socket = secure;
		this.encrypted = true;
		this.framer.clear();
		this.attach(secure);
		this.armIdle();
		return { skipResponse: true };
	}

	private async login(command: ParsedCommand): Promise<Completion> {
		const [user, password, ...extra] = command.attributes ?? [];
		const text = (node: unknown) => (node && !Array.isArray(node) && typeof (node as { value?: unknown }).value === "string" ? (node as { value: string }).value : null);
		const username = text(user);
		const secret = text(password);
		if (username === null || secret === null || extra.length) throw bad("LOGIN takes a user name and a password");
		return this.authorize(Buffer.from(username, "latin1").toString("utf8"), secret);
	}

	private async authenticate(command: ParsedCommand, name: string): Promise<Completion> {
		const mechanism = name.slice("AUTHENTICATE".length).trim().toUpperCase();
		const words = (command.attributes ?? []).map((node) => (node && !Array.isArray(node) && typeof (node as { value?: unknown }).value === "string" ? (node as { value: string }).value : null));
		if (words.length > 1 || words.some((word) => word === null)) throw bad("AUTHENTICATE takes a mechanism and at most an initial response");
		let initial: string | null = words[0] ?? null;
		if (mechanism !== "PLAIN") throw new ImapError("NO", "Mechanism not supported", "CANNOT");
		if (!this.loginAllowed()) throw new ImapError("NO", "Log in only over TLS", "PRIVACYREQUIRED");
		if (initial === null) {
			this.send("+ ");
			initial = await this.nextRawLine();
			if (initial === null) throw bad("The authentication exchange ended");
		}
		if (initial === "*") throw bad("Authentication cancelled");
		const decoded = initial === "=" ? Buffer.alloc(0) : /^[A-Za-z0-9+/]*={0,2}$/.test(initial) && initial.length % 4 === 0 ? Buffer.from(initial, "base64") : null;
		const parts = decoded?.toString("utf8").split("\0");
		if (!parts || parts.length !== 3) return this.failLogin("malformed", "");
		const [authzid, authcid, secret] = parts;
		if (authzid && authzid !== authcid) return this.failLogin("malformed", authcid);
		return this.authorize(authcid, secret);
	}

	/** The next line the client sends, for an authentication reply or DONE; null when the connection ends first. */
	async nextRawLine(): Promise<string | null> {
		for (;;) {
			const event = this.framer.next();
			if (event?.type === "command") return event.text;
			if (event?.type === "reject") {
				if (event.close) void this.bye("Line too long");
				return null;
			}
			if (event?.type === "continue") {
				// A reply that ends in `{n}` is framed as a literal; the client waits for this before it sends the bytes.
				if (!(await this.pace())) return null;
				this.send("+ Ready");
				continue;
			}
			if (this.closed || this.closing) return null;
			await this.waitForSignal();
		}
	}

	/**
	 * One log line per failed login, for fail2ban and the like: the address (an IPv6 client by its /64, the
	 * same bucket the guess budget uses), why it failed, and the user name cut to 64 printable characters.
	 * Never the password. The line is not an audit entry; nothing is written to the database.
	 */
	private logFailure(reason: LoginFailure, username: string): void {
		const ip = this.remoteAddress ? ipBucket(this.remoteAddress) : "unknown";
		console.warn(`IMAP login failed ip=${ip} reason=${reason} user=${JSON.stringify(printable(username).slice(0, 64))}`);
	}

	private async failLogin(reason: LoginFailure, username: string): Promise<Completion> {
		this.logFailure(reason, username);
		const throttled = reason === "throttled";
		this.failedLogins += 1;
		if (this.context.failureDelayMs) await new Promise((resolve) => setTimeout(resolve, this.context.failureDelayMs));
		if (this.failedLogins >= MAX_FAILED_LOGINS) {
			await this.bye("Too many failed logins", false);
			throw new ImapError("NO", "Too many failed logins", "AUTHENTICATIONFAILED");
		}
		if (throttled) throw new ImapError("NO", "Too many login attempts; try again later", "UNAVAILABLE");
		throw new ImapError("NO", "Authentication failed", "AUTHENTICATIONFAILED");
	}

	private async authorize(username: string, secret: string): Promise<Completion> {
		if (!this.loginAllowed()) throw new ImapError("NO", "Log in only over TLS", "PRIVACYREQUIRED");
		const result = await authenticateImap(this.env, { username, secret, ip: this.remoteAddress, client: this.clientName });
		if (!result.ok) return this.failLogin(result.reason, username);
		if (!this.context.admitUser(result.identity.userId)) throw new ImapError("NO", "Too many connections for this account", "UNAVAILABLE");
		this.identity = result.identity;
		this.phase = "auth";
		this.framer.limits = { ...AUTH_LIMITS, maxAppend: this.context.maxMessageSize };
		if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
		this.deadlineTimer = null;
		this.armIdle();
		this.revalidateTimer = setInterval(() => void this.checkCredentials(), this.context.timeouts?.revalidateMs ?? REVALIDATE_MS);
		this.revalidateTimer.unref();
		return { code: `CAPABILITY ${this.capabilities().join(" ")}`, text: "Logged in" };
	}

	// ---- IDLE ----

	/** Called by the notifier: something changed in the selected folder's mailbox. */
	changed(): void {
		this.dirty = true;
		if (this.idling) {
			this.idleUpdate = true;
			this.signal();
		}
	}

	private async idle(): Promise<Completion> {
		if (this.selected) await this.requireAccess();
		if (this.selected && this.dirty) await this.pushUpdates();
		this.send("+ idling");
		this.idling = true;
		try {
			for (;;) {
				const event = this.framer.next();
				if (event?.type === "command") {
					if (event.text.trim().toUpperCase() === "DONE") return { text: "IDLE terminated" };
					throw bad("Expected DONE");
				}
				if (event?.type === "reject") throw bad("Expected DONE");
				if (this.closed || this.closing) return;
				if (this.idleUpdate) {
					this.idleUpdate = false;
					await this.waitForOutput();
					if (this.selected) {
						try {
							await this.requireAccess();
							await this.pushUpdates();
						} catch (error) {
							if (this.closing) return;
							throw error;
						}
					}
					continue;
				}
				if (!event) await this.waitForSignal();
			}
		} finally {
			this.idling = false;
		}
	}
}
