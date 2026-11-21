import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

/** A line-level SMTP test client over a real socket: every call resolves with the full (possibly multi-line) reply. */
export class SmtpClient {
	constructor(socket) {
		this.socket = socket;
		this.buffer = "";
		this.closed = false;
		this.waiters = new Set();
		this.closedPromise = new Promise((resolve) =>
			socket.once("close", () => {
				this.closed = true;
				resolve();
				this.poke();
			}),
		);
		socket.on("data", (chunk) => {
			this.buffer += chunk.toString("latin1");
			this.poke();
		});
		socket.on("error", () => {});
	}
	poke() {
		for (const waiter of [...this.waiters]) waiter();
	}
	waitFor(test, ms = 5000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters.delete(check);
				reject(new Error(`timed out; buffer so far: ${JSON.stringify(this.buffer.slice(-600))}`));
			}, ms);
			const check = () => {
				const value = test(this.buffer);
				if (value !== undefined && value !== false && value !== null) {
					clearTimeout(timer);
					this.waiters.delete(check);
					resolve(value);
				} else if (this.closed) {
					clearTimeout(timer);
					this.waiters.delete(check);
					reject(new Error(`closed; buffer: ${JSON.stringify(this.buffer.slice(-600))}`));
				}
			};
			this.waiters.add(check);
			check();
		});
	}
	/** The next complete reply: lines up to and including the first one that is `NNN text` (not `NNN-text`). */
	async reply(ms) {
		const end = await this.waitFor((buffer) => {
			let from = 0;
			for (;;) {
				const stop = buffer.indexOf("\r\n", from);
				if (stop < 0) return undefined;
				if (/^\d{3}( |$)/.test(buffer.slice(from, stop))) return stop + 2;
				from = stop + 2;
			}
		}, ms);
		const text = this.buffer.slice(0, end);
		this.buffer = this.buffer.slice(end);
		const lines = text.split("\r\n").filter(Boolean);
		return { text, lines, code: Number(lines[0].slice(0, 3)) };
	}
	write(text) {
		this.socket.write(Buffer.from(text, "latin1"));
	}
	async cmd(line, ms) {
		this.write(`${line}\r\n`);
		return this.reply(ms);
	}
	/** Sends a message body after DATA's 354 (dot-stuffing is the caller's business) and returns the final reply. */
	async data(body, ms) {
		this.write(body.endsWith("\r\n") ? body : `${body}\r\n`);
		this.write(".\r\n");
		return this.reply(ms);
	}
	async authPlain(user, secret) {
		return this.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${secret}`).toString("base64")}`);
	}
	end() {
		this.socket.destroy();
	}
}

export function connectSmtpTls(port, ca) {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => resolve(new SmtpClient(socket)));
		socket.once("error", reject);
	});
}
export function connectSmtpPlain(port) {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(new SmtpClient(socket)));
		socket.once("error", reject);
	});
}
export function upgradeSmtp(client, ca) {
	return new Promise((resolve, reject) => {
		const raw = client.socket;
		raw.removeAllListeners("data");
		const socket = tlsConnect({ socket: raw, ca, servername: "localhost" }, () => resolve(new SmtpClient(socket)));
		socket.once("error", reject);
	});
}
