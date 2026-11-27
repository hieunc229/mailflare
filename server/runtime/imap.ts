import { readFileSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { authenticateAppPassword, allowAppPasswordGuess } from "@/lib/auth/app-passwords";
import type { ApiAuthResult } from "@/lib/api/key-auth-types";
import { isImapEnabled } from "@/lib/imap/settings";
import { dispatchImapCommand, loginResult, parseImapCommand, quoteImapLiteral, type ImapSessionState } from "./imap-protocol";

const MAX_CLIENTS = 100;
const MAX_CONNECTIONS_PER_IP = 10;
const SOCKET_TIMEOUT_MS = 60_000;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_LITERAL_BYTES = 1024 * 1024;
type ImapOptions = { port: number; host?: string; tls: { keyPath: string; certPath: string } | null };

/** Start an IMAP skeleton listener. Without certificate paths it accepts plaintext; configure TLS for credential privacy. */
export function startImapListener(env: CloudflareEnv, options: ImapOptions) {
	const connectionsByIp = new Map<string, number>();
	const admitted = new Set<Socket>();
	const onConnection = (socket: Socket) => {
		const ip = socket.remoteAddress ?? "unknown";
		const count = (connectionsByIp.get(ip) ?? 0) + 1;
		if (count > MAX_CONNECTIONS_PER_IP || admitted.size >= MAX_CLIENTS) { socket.end("* BYE Too many connections\r\n"); return; }
		admitted.add(socket);
		connectionsByIp.set(ip, count);
		socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
		socket.write("* OK Mailflare IMAP4rev1 server ready\r\n");
		let buffer = Buffer.alloc(0);
		let pendingPrefix: string | null = null;
		let pendingLiteralLength = 0;
		let pendingLiteralNonSynchronizing = false;
		const session: { state: ImapSessionState; auth: ApiAuthResult | null } = { state: "not-authenticated", auth: null };

		let commandQueue = Promise.resolve();
		const enqueueLine = (line: string) => {
			commandQueue = commandQueue.then(() => handleLine(line)).catch((error: unknown) => {
				console.error("IMAP command failed", error);
				socket.write("* BYE Temporary server error\r\n");
				socket.end();
			});
		};
		const handleLine = async (line: string) => {
			const command = parseImapCommand(line);
			if (!command) { socket.write("* BAD Invalid command syntax\r\n"); return; }
			const action = dispatchImapCommand(session.state, command);
			if (action.login) {
				if (!(await isImapEnabled(env))) { socket.write(`${command.tag} NO IMAP disabled\r\n`); return; }
				const ipAddress = socket.remoteAddress ?? null;
				const request = new Request("http://localhost/", { headers: ipAddress ? { "x-mailflare-client-ip": ipAddress } : {} });
				const secret = action.login.password.replace(/[\s-]/g, "");
				const allowed = await allowAppPasswordGuess(env, request, secret, "app");
				const auth = allowed && await authenticateAppPassword(env, { secret, protocol: "imap", clientIp: ipAddress });
				const result = loginResult(command.tag, !!auth);
				session.auth = auth || null;
				session.state = result.state ?? session.state;
				socket.write(result.response);
				return;
			}
			session.state = action.state ?? session.state;
			socket.write(action.response);
			if (session.state === "logged-out") { session.auth = null; socket.end(); }
		};

		const consume = () => {
			while (!socket.destroyed) {
				if (pendingPrefix !== null) {
					if (buffer.length < pendingLiteralLength) return;
					const literal = buffer.subarray(0, pendingLiteralLength).toString("utf8");
					buffer = Buffer.concat([Buffer.from(pendingPrefix + quoteImapLiteral(literal)), buffer.subarray(pendingLiteralLength)]);
					pendingPrefix = null;
					continue;
				}
				const end = buffer.indexOf("\r\n");
				if (end < 0) {
					if (buffer.length > MAX_LINE_BYTES) { socket.write("* BAD Command line too long\r\n"); socket.destroy(); }
					return;
				}
				const line = buffer.subarray(0, end).toString("utf8");
				buffer = buffer.subarray(end + 2);
				const literal = /\{(\d+)\+?\}$/.exec(line);
				if (literal) {
					pendingLiteralLength = Number(literal[1]);
					if (!Number.isSafeInteger(pendingLiteralLength) || pendingLiteralLength > MAX_LITERAL_BYTES) { socket.write("* BAD Literal too large\r\n"); socket.destroy(); return; }
					pendingLiteralNonSynchronizing = literal[0].endsWith("+");
					pendingPrefix = line.slice(0, literal.index);
					if (!pendingLiteralNonSynchronizing) socket.write("+ Ready for literal data\r\n");
					continue;
				}
				enqueueLine(line);
			}
		};
		socket.on("data", (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); consume(); });
		socket.on("close", () => {
			if (!admitted.delete(socket)) return;
			const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
			if (remaining <= 0) connectionsByIp.delete(ip);
			else connectionsByIp.set(ip, remaining);
		});
	};
	const server = options.tls
		? createTlsServer({ key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) }, onConnection)
		: createNetServer(onConnection);
	server.on("error", (error) => console.error("IMAP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => console.log(`IMAP listener listening on ${options.host ?? "0.0.0.0"}:${options.port}${options.tls ? " (TLS)" : " (plaintext)"}`));
	return server;
}
