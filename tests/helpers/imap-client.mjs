import { connect as tlsConnect } from "node:tls";
import { connect as netConnect } from "node:net";

/** A line-level IMAP test client over a real socket. Everything is kept as a binary string. */
export class Client {
	constructor(socket) {
		this.socket = socket;
		this.buffer = "";
		this.closed = false;
		this.waiters = new Set();
		this.counter = 0;
		this.closedPromise = new Promise((resolve) => socket.once("close", () => { this.closed = true; resolve(); this.poke(); }));
		socket.on("data", (chunk) => { this.buffer += chunk.toString("latin1"); this.poke(); });
		socket.on("error", () => {});
	}
	poke() { for (const waiter of [...this.waiters]) waiter(); }
	waitFor(test, ms = 5000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { this.waiters.delete(check); reject(new Error(`timed out; buffer so far: ${JSON.stringify(this.buffer.slice(-600))}`)); }, ms);
			const check = () => {
				const value = test(this.buffer);
				if (value !== undefined && value !== false && value !== null) { clearTimeout(timer); this.waiters.delete(check); resolve(value); }
				else if (this.closed) { clearTimeout(timer); this.waiters.delete(check); reject(new Error(`closed; buffer: ${JSON.stringify(this.buffer.slice(-600))}`)); }
			};
			this.waiters.add(check);
			check();
		});
	}
	/** Waits for text, consumes the buffer up to its end. */
	async expect(text, ms) {
		const index = await this.waitFor((buffer) => { const at = buffer.indexOf(text); return at >= 0 ? at + text.length : undefined; }, ms);
		const consumed = this.buffer.slice(0, index);
		this.buffer = this.buffer.slice(index);
		return consumed;
	}
	async greeting() { return this.expect("\r\n"); }
	write(text) { this.socket.write(Buffer.from(text, "latin1")); }
	/** Sends `<tag> <line>` and resolves with everything up to and including the tagged response. */
	async cmd(line, { tag = `a${++this.counter}`, ms } = {}) {
		this.write(`${tag} ${line}\r\n`);
		return this.finish(tag, ms);
	}
	async finish(tag, ms) {
		const pattern = new RegExp(`(^|\\r\\n)${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`);
		const end = await this.waitFor((buffer) => { const match = pattern.exec(buffer); return match ? match.index + match[0].length : undefined; }, ms);
		const text = this.buffer.slice(0, end);
		this.buffer = this.buffer.slice(end);
		const last = text.match(new RegExp(`${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (OK|NO|BAD)([^\\r\\n]*)\\r\\n$`));
		return { text, status: last[1], detail: last[2].trim(), lines: text.split("\r\n") };
	}
	async login(user, secret) { return this.cmd(`LOGIN "${user}" "${secret}"`); }
	end() { this.socket.destroy(); }
}

export function connectTlsClient(port, ca) {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: "127.0.0.1", port, ca, servername: "localhost" }, () => resolve(new Client(socket)));
		socket.once("error", reject);
	});
}
export function connectPlainClient(port) {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(new Client(socket)));
		socket.once("error", reject);
	});
}
export function upgradeToTls(client, ca) {
	return new Promise((resolve, reject) => {
		const raw = client.socket;
		raw.removeAllListeners("data");
		const socket = tlsConnect({ socket: raw, ca, servername: "localhost" }, () => resolve(new Client(socket)));
		socket.once("error", reject);
	});
}
