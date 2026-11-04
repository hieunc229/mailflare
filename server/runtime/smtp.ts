import { readFileSync } from "node:fs";
import { SMTPServer } from "smtp-server";
import type { SMTPServerSession } from "smtp-server";
import { intakeIncomingMail } from "@/lib/email/intake";
import { inboundAttachmentLimitReasonFromRaw } from "@/lib/email/inbound-attachments";
import { isPublicIpv4 } from "@/lib/spam/domain-utils";
import { getDb } from "@/db";
import { domains } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifySmtpAuthentication } from "./smtp-auth";
import type { Mailer } from "./mailer";

const MAX_CLIENTS = 100;
const MAX_CONNECTIONS_PER_IP = 10;
const MAX_RECIPIENTS = 50;
const SOCKET_TIMEOUT_MS = 60_000;

/** Headers a sender can write but only the receiving side may vouch for. */
const UNTRUSTED_HEADERS = ["authentication-results", "received-spf", "arc-authentication-results", "received"];

/**
 * Receive mail directly on port 25 (or wherever SMTP_INBOUND_PORT points).
 * One inbound connection per message; each envelope recipient is handed to
 * the same intake the Cloudflare handler uses. Rejected mail gets a 550
 * during DATA, so the sender sees the routing rule's reason.
 */
export function startSmtpListener(
	env: CloudflareEnv,
	mailer: Mailer,
	options: { port: number; host?: string; maxSize: number; hostname?: string; tls: { keyPath: string; certPath: string } | null },
) {
	// STARTTLS is only offered with a real certificate; smtp-server's built-in
	// one has a public private key, and advertising it would mislead senders.
	const connectionsByIp = new Map<string, number>();
	// Only sessions that were admitted are counted, so rejected ones cannot decrement on close.
	const admittedSessions = new Set<string>();
	const server = new SMTPServer({
		maxClients: MAX_CLIENTS,
		socketTimeout: SOCKET_TIMEOUT_MS,
		onConnect(session, callback) {
			const ip = session.remoteAddress;
			const count = (connectionsByIp.get(ip) ?? 0) + 1;
			// maxClients in smtp-server admits one connection past the limit, so enforce it here too.
			if (count > MAX_CONNECTIONS_PER_IP || admittedSessions.size >= MAX_CLIENTS) {
				callback(Object.assign(new Error("Too many connections"), { responseCode: 421 }));
				return;
			}
			admittedSessions.add(session.id);
			connectionsByIp.set(ip, count);
			callback();
		},
		onClose(session) {
			if (!admittedSessions.delete(session.id)) return;
			const ip = session.remoteAddress;
			const count = (connectionsByIp.get(ip) ?? 1) - 1;
			if (count <= 0) connectionsByIp.delete(ip);
			else connectionsByIp.set(ip, count);
		},
		onRcptTo(address, session, callback) {
			if (session.envelope.rcptTo.length >= MAX_RECIPIENTS) {
				callback(Object.assign(new Error("Too many recipients"), { responseCode: 452 }));
				return;
			}
			// Refuse unknown domains before DATA so nothing is buffered for mail we would drop anyway.
			const hostname = address.address.slice(address.address.lastIndexOf("@") + 1).toLowerCase();
			getDb(env).select({ id: domains.id }).from(domains).where(eq(domains.hostname, hostname)).limit(1).then(
				([domain]) => callback(domain ? undefined : Object.assign(new Error("Relay access denied"), { responseCode: 550 })),
				(error) => {
					console.error("SMTP recipient lookup failed", error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
				},
			);
		},
		name: options.hostname,
		authOptional: true,
		disabledCommands: options.tls ? ["AUTH"] : ["AUTH", "STARTTLS"],
		...(options.tls ? { key: readFileSync(options.tls.keyPath), cert: readFileSync(options.tls.certPath) } : {}),
		size: options.maxSize,
		banner: "Mailflare",
		onData(stream, session: SMTPServerSession, callback) {
			const chunks: Buffer[] = [];
			let received = 0;
			stream.on("data", (chunk: Buffer) => {
				// Stop buffering once over the limit; the 552 is sent when the stream ends.
				received += chunk.length;
				if (received <= options.maxSize) chunks.push(chunk);
				else chunks.length = 0;
			});
			stream.on("end", async () => {
				if (stream.sizeExceeded) {
					const error = Object.assign(new Error("Message exceeds size limit"), { responseCode: 552 });
					callback(error);
					return;
				}
				const raw = Buffer.concat(chunks);
				let attachmentLimitReason: string | null;
				try {
					attachmentLimitReason = await inboundAttachmentLimitReasonFromRaw(toArrayBuffer(raw));
				} catch (error) {
					console.error("SMTP attachment inspection failed", error);
					callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
					return;
				}
				if (attachmentLimitReason) {
					callback(Object.assign(new Error(attachmentLimitReason), { responseCode: 552 }));
					return;
				}
				const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
				const headers = parseHeaders(raw);
				// No SPF/DKIM/DMARC verification happens here, so anything the sender wrote is untrusted.
				for (const name of UNTRUSTED_HEADERS) delete headers[name];
				const senderIp = isPublicIpv4(session.remoteAddress) ? session.remoteAddress : undefined;
				const verdicts = await verifySmtpAuthentication(raw, {
					ip: session.remoteAddress,
					helo: session.hostNameAppearsAs,
					sender: from,
					mta: options.hostname,
				});
				let rejectReason: string | null = null;
				for (const recipient of session.envelope.rcptTo) {
					const result = await intakeIncomingMail(
						env,
						{ from, to: recipient.address, raw: toArrayBuffer(raw), headers, senderIp, verdicts },
						{
							reject: (reason) => {
								rejectReason = reason;
							},
							forward: async (destination) => mailer.sendRaw(from, destination, raw),
						},
					).catch((error) => {
						console.error(`SMTP intake failed for ${recipient.address}`, error);
						return null;
					});
					if (!result) {
						callback(Object.assign(new Error("Temporary failure, try again later"), { responseCode: 451 }));
						return;
					}
				}
				if (rejectReason) {
					callback(Object.assign(new Error(rejectReason), { responseCode: 550 }));
					return;
				}
				callback();
			});
		},
	});
	server.on("error", (error) => console.error("SMTP listener error", error));
	server.listen(options.port, options.host ?? "0.0.0.0", () => {
		console.log(`SMTP inbound listening on ${options.host ?? "0.0.0.0"}:${options.port}`);
	});
	return server;
}

/** Header map in the shape the Worker handler provides: lower-cased names, folded lines joined. */
export function parseHeaders(raw: Buffer): Record<string, string> {
	const text = new TextDecoder("latin1").decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
	const end = text.search(/\r?\n\r?\n/);
	const block = (end >= 0 ? text.slice(0, end) : text).replace(/\r?\n[ \t]+/g, " ");
	const headers: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		const name = line.slice(0, index).trim().toLowerCase();
		if (!(name in headers)) headers[name] = line.slice(index + 1).trim();
	}
	return headers;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}
