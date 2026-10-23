/**
 * Imports a Google Takeout Gmail export (.mbox) into a Mailflare mailbox.
 *
 *   node scripts/import-gmail-takeout.mjs \
 *     --url https://mailflare.example.workers.dev \
 *     --mailbox you@example.com \
 *     --file "All mail Including Spam and Trash.mbox"
 *
 * The file is streamed, so its size does not matter. Gmail labels decide where
 * each message lands: Inbox, Sent, Drafts, Spam and Trash map to those
 * sections, other labels become folders (first matching label wins), and mail
 * without either is archived. Unread and Starred carry over. Messages are sent
 * in uploads of at most 100 messages / 20 MB to /api/import/messages, which
 * skips duplicates, so an interrupted run can simply be started again.
 *
 * Sign-in: set MAILFLARE_TOKEN to a session token (DevTools → Application →
 * Local Storage → mailflare-session-token), or pass --email and enter the
 * password (and a 2FA code) when asked. MAILFLARE_PASSWORD skips the prompt.
 *
 * Options:
 *   --dry-run               parse the file and print where messages would go
 *   --no-folders            archive mail with custom labels instead of creating folders
 *   --ignore-label <name>   ignore a label, or every label below it with a trailing "/" (repeatable)
 *   --skip-spam, --skip-trash
 *   --start-at <n>          skip the first n messages of the file
 */

import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MAX_BATCH_MESSAGES = 100;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 60 * 1024 * 1024;
// The import endpoint caps a whole request at 25 MiB, form overhead included.
const MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const MAX_FOLDER_NAME = 80;

const SYSTEM_LABELS = {
	inbox: ["inbox", "posteingang"],
	sent: ["sent", "gesendet"],
	drafts: ["drafts", "draft", "entwürfe"],
	spam: ["spam"],
	trash: ["trash", "bin", "papierkorb"],
};
const STARRED_LABELS = ["starred", "markiert"];
const UNREAD_LABELS = ["unread", "ungelesen"];
const IGNORED_LABELS = ["opened", "geöffnet", "important", "wichtig", "archived", "archiviert", "chat", "chats"];
const IGNORED_LABEL_PREFIXES = ["category ", "kategorie "];
const SECTION_PRIORITY = ["trash", "spam", "drafts", "sent", "inbox"];

/**
 * Splits an mbox byte stream into raw RFC 822 messages without decoding the
 * bodies, so 8-bit and binary content survives unchanged.
 */
export async function* readMboxMessages(stream) {
	let carry = Buffer.alloc(0);
	let lines = null;
	let previousBlank = true;

	function finish() {
		if (!lines) return null;
		while (lines.length > 0 && /^\r?\n$/.test(lines.at(-1).toString("latin1"))) lines.pop();
		const raw = Buffer.concat(lines);
		lines = null;
		return raw;
	}

	function* handle(line) {
		const isSeparator = line.subarray(0, 5).toString("latin1") === "From " && previousBlank;
		previousBlank = line.length <= 2 && /^\r?\n?$/.test(line.toString("latin1"));
		if (isSeparator) {
			const raw = finish();
			if (raw) yield raw;
			lines = [];
			return;
		}
		if (!lines) return;
		lines.push(/^>+From /.test(line.subarray(0, 64).toString("latin1")) ? line.subarray(1) : line);
	}

	for await (const chunk of stream) {
		const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
		let start = 0;
		while (true) {
			const end = data.indexOf(10, start);
			if (end === -1) break;
			yield* handle(Buffer.from(data.subarray(start, end + 1)));
			start = end + 1;
		}
		carry = Buffer.from(data.subarray(start));
	}
	if (carry.length > 0) yield* handle(carry);
	const last = finish();
	if (last) yield last;
}

function decodeEncodedWords(value) {
	return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (match, charset, encoding, text) => {
		try {
			const bytes = encoding.toLowerCase() === "b"
				? Buffer.from(text, "base64")
				: Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1");
			return new TextDecoder(charset).decode(bytes);
		} catch {
			return match;
		}
	});
}

/** Reads the X-Gmail-Labels header of a raw message. */
export function parseGmailLabels(raw) {
	const ends = [raw.indexOf("\n\n"), raw.indexOf("\r\n\r\n")].filter((index) => index >= 0);
	const headerEnd = ends.length > 0 ? Math.min(...ends) : Math.min(raw.length, 64 * 1024);
	const headers = raw.subarray(0, headerEnd).toString("utf8").replace(/\r?\n[ \t]+/g, " ");
	const match = headers.match(/^X-Gmail-Labels:[ \t]*(.*)$/im);
	if (!match) return [];
	const labels = [];
	let current = "";
	let quoted = false;
	for (const char of decodeEncodedWords(match[1])) {
		if (char === '"') quoted = !quoted;
		else if (char === "," && !quoted) {
			labels.push(current.trim());
			current = "";
		} else current += char;
	}
	labels.push(current.trim());
	return labels.filter(Boolean);
}

function isIgnoredLabel(label, ignore) {
	const name = label.toLowerCase();
	if (IGNORED_LABELS.includes(name) || IGNORED_LABEL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
	return ignore.some((entry) => {
		const value = entry.toLowerCase();
		return value.endsWith("/") ? name === value.slice(0, -1) || name.startsWith(value) : name === value;
	});
}

/**
 * Decides where a message goes from its Gmail labels.
 * @returns {{ destination: { type: "system", section: string } | { type: "folder", name: string }, read: boolean, starred: boolean }}
 */
export function mapGmailLabels(labels, options = {}) {
	const names = labels.map((label) => label.toLowerCase());
	const read = !names.some((name) => UNREAD_LABELS.includes(name));
	const starred = names.some((name) => STARRED_LABELS.includes(name));
	const section = SECTION_PRIORITY.find((key) => names.some((name) => SYSTEM_LABELS[key].includes(name)));
	if (section) return { destination: { type: "system", section }, read, starred };

	const known = new Set([...Object.values(SYSTEM_LABELS).flat(), ...STARRED_LABELS, ...UNREAD_LABELS]);
	const folder = options.folders === false
		? undefined
		: labels.find((label) => !known.has(label.toLowerCase()) && !isIgnoredLabel(label, options.ignore ?? []));
	if (folder) return { destination: { type: "folder", name: folder.slice(0, MAX_FOLDER_NAME) }, read, starred };
	return { destination: { type: "system", section: "archived" }, read, starred };
}

function destinationKey(destination) {
	return destination.type === "folder" ? `folder:${destination.name}` : `system:${destination.section}`;
}

function prompt(question, { hidden = false } = {}) {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
	if (hidden) {
		rl._writeToOutput = (text) => {
			if (text.startsWith(question)) process.stdout.write(question);
		};
	}
	return new Promise((resolve) => {
		rl.question(question, (answer) => {
			rl.close();
			if (hidden) process.stdout.write("\n");
			resolve(answer.trim());
		});
	});
}

class MailflareClient {
	constructor(baseUrl, token) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.token = token;
	}

	static async signIn(baseUrl, email) {
		const url = baseUrl.replace(/\/$/, "");
		const password = process.env.MAILFLARE_PASSWORD || (await prompt(`Mailflare password for ${email}: `, { hidden: true }));
		const login = await fetch(`${url}/api/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: url },
			body: JSON.stringify({ email, password }),
		});
		let data = await login.json().catch(() => ({}));
		if (!login.ok) {
			throw new Error(`Sign-in failed (${login.status}): ${JSON.stringify(data.error ?? data)}. If sign-in uses a captcha, set MAILFLARE_TOKEN instead.`);
		}
		if (data.mfaRequired) {
			const code = await prompt("Two-factor code: ");
			const verify = await fetch(`${url}/api/auth/mfa/verify`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: url },
				body: JSON.stringify({ challengeToken: data.challengeToken, code }),
			});
			data = await verify.json().catch(() => ({}));
			if (!verify.ok) throw new Error(`Two-factor verification failed (${verify.status}): ${data.error ?? ""}`);
		}
		if (!data.token) throw new Error("Sign-in returned no session token");
		return new MailflareClient(url, data.token);
	}

	async request(path, init = {}) {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${this.token}`);
		const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
		const text = await response.text();
		let data;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			data = { error: `HTTP ${response.status} (non-JSON response)` };
		}
		return { response, data };
	}

	async findMailbox(selector) {
		const { response, data } = await this.request("/api/mailboxes");
		if (!response.ok) throw new Error(`Could not list mailboxes (${response.status}): ${data.error ?? ""}. Check that the session token is valid.`);
		const wanted = selector.toLowerCase();
		const mailbox = data.mailboxes.find((item) =>
			item.id === selector || (item.senderAddresses ?? []).some((address) => address.toLowerCase() === wanted),
		);
		if (!mailbox) {
			const known = data.mailboxes.map((item) => `${item.id} (${(item.senderAddresses ?? []).join(", ")})`).join("\n  ");
			throw new Error(`Mailbox ${selector} not found. Available:\n  ${known}`);
		}
		return mailbox;
	}

	async listFolders(mailboxId) {
		const { response, data } = await this.request(`/api/folders?mailboxId=${encodeURIComponent(mailboxId)}`);
		if (!response.ok) throw new Error(`Could not list folders (${response.status}): ${data.error ?? ""}`);
		return data.folders ?? [];
	}

	async createFolder(mailboxId, name) {
		const { response, data } = await this.request("/api/folders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, name }),
		});
		if (response.status === 409) return null;
		if (!response.ok) throw new Error(`Could not create folder ${name} (${response.status}): ${JSON.stringify(data.error ?? "")}`);
		return data.id;
	}

	async upload(mailboxId, destination, messages) {
		const form = new FormData();
		form.set("mailboxId", mailboxId);
		form.set("destination", destination);
		form.set("flags", JSON.stringify(Object.fromEntries(messages.map((message) => [message.filename, { read: message.read, starred: message.starred }]))));
		for (const message of messages) {
			form.append("files", new Blob([message.raw], { type: "message/rfc822" }), message.filename);
		}
		return this.request("/api/import/messages", { method: "POST", body: form });
	}
}

class FolderResolver {
	constructor(client, mailboxId) {
		this.client = client;
		this.mailboxId = mailboxId;
		this.ids = null;
	}

	async resolve(name) {
		if (!this.ids) await this.refresh();
		const existing = this.ids.get(name.toLowerCase());
		if (existing) return existing;
		const created = await this.client.createFolder(this.mailboxId, name);
		if (created) {
			this.ids.set(name.toLowerCase(), created);
			return created;
		}
		await this.refresh();
		const found = this.ids.get(name.toLowerCase());
		if (!found) throw new Error(`Folder ${name} could not be created`);
		return found;
	}

	async refresh() {
		const folders = await this.client.listFolders(this.mailboxId);
		this.ids = new Map(folders.map((folder) => [folder.name.toLowerCase(), folder.id]));
	}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function uploadWithRetry(client, mailboxId, destination, messages, totals) {
	for (let attempt = 1; ; attempt += 1) {
		let result;
		try {
			result = await client.upload(mailboxId, destination, messages);
		} catch (error) {
			result = { response: null, data: { error: error instanceof Error ? error.message : String(error) } };
		}
		const status = result.response?.status ?? 0;
		if (result.response?.ok) {
			totals.imported += result.data.imported ?? 0;
			totals.skipped += result.data.skipped ?? 0;
			totals.errors.push(...(result.data.errors ?? []));
			return;
		}
		if (messages.length > 1 && (status === 413 || (status >= 500 && attempt >= 2))) {
			const middle = Math.ceil(messages.length / 2);
			await uploadWithRetry(client, mailboxId, destination, messages.slice(0, middle), totals);
			await uploadWithRetry(client, mailboxId, destination, messages.slice(middle), totals);
			return;
		}
		if (status === 413) {
			totals.errors.push(`${messages[0].filename}: too large for one upload`);
			return;
		}
		const retryable = status === 0 || status === 429 || status >= 500;
		if (!retryable || attempt >= 4) {
			throw new Error(`Upload to ${destination} failed (${status || "network"}): ${JSON.stringify(result.data.error ?? result.data)}`);
		}
		await sleep(5000 * 3 ** (attempt - 1));
	}
}

function formatBytes(bytes) {
	return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

async function main() {
	const { values } = parseArgs({
		options: {
			url: { type: "string", default: process.env.MAILFLARE_URL },
			mailbox: { type: "string" },
			file: { type: "string" },
			email: { type: "string" },
			"dry-run": { type: "boolean", default: false },
			"no-folders": { type: "boolean", default: false },
			"ignore-label": { type: "string", multiple: true, default: [] },
			"skip-spam": { type: "boolean", default: false },
			"skip-trash": { type: "boolean", default: false },
			"start-at": { type: "string", default: "0" },
		},
	});
	if (!values.file) throw new Error("--file is required");
	const options = { folders: !values["no-folders"], ignore: values["ignore-label"] };
	const startAt = Math.max(0, Number(values["start-at"]) || 0);
	const fileSize = statSync(values.file).size;

	let client = null;
	let mailboxId = null;
	let folders = null;
	if (!values["dry-run"]) {
		if (!values.url || !values.mailbox) throw new Error("--url and --mailbox are required");
		client = process.env.MAILFLARE_TOKEN
			? new MailflareClient(values.url, process.env.MAILFLARE_TOKEN)
			: await MailflareClient.signIn(values.url, values.email ?? values.mailbox);
		const mailbox = await client.findMailbox(values.mailbox);
		mailboxId = mailbox.id;
		folders = new FolderResolver(client, mailboxId);
		console.log(`Importing ${values.file} (${formatBytes(fileSize)}) into ${values.mailbox} (${mailboxId})`);
	}

	const totals = { imported: 0, skipped: 0, errors: [] };
	const destinations = new Map();
	const groups = new Map();
	let buffered = 0;
	let index = 0;
	let readBytes = 0;
	let tooLarge = 0;
	let ignored = 0;

	const report = () => {
		const percent = fileSize ? Math.min(100, (readBytes / fileSize) * 100).toFixed(1) : "100";
		process.stdout.write(`\r${index} messages read (${percent}%), ${totals.imported} imported, ${totals.skipped} skipped   `);
	};

	async function flush(key) {
		const group = groups.get(key);
		if (!group || group.messages.length === 0) return;
		groups.delete(key);
		buffered -= group.bytes;
		const destination = group.destination.type === "folder"
			? `folder:${await folders.resolve(group.destination.name)}`
			: `system:${group.destination.section}`;
		await uploadWithRetry(client, mailboxId, destination, group.messages, totals);
		report();
	}

	for await (const raw of readMboxMessages(createReadStream(values.file))) {
		index += 1;
		readBytes += raw.length;
		if (index <= startAt) continue;
		const { destination, read, starred } = mapGmailLabels(parseGmailLabels(raw), options);
		if ((values["skip-spam"] && destination.section === "spam") || (values["skip-trash"] && destination.section === "trash")) {
			ignored += 1;
			continue;
		}
		if (raw.length > MAX_MESSAGE_BYTES) {
			tooLarge += 1;
			continue;
		}
		const key = destinationKey(destination);
		destinations.set(key, (destinations.get(key) ?? 0) + 1);
		if (values["dry-run"]) continue;

		const group = groups.get(key);
		if (group && (group.messages.length >= MAX_BATCH_MESSAGES || group.bytes + raw.length > MAX_BATCH_BYTES)) await flush(key);
		const target = groups.get(key) ?? { destination, messages: [], bytes: 0 };
		target.messages.push({ filename: `takeout-${index}.eml`, raw, read, starred });
		target.bytes += raw.length;
		groups.set(key, target);
		buffered += raw.length;
		while (buffered > MAX_BUFFERED_BYTES) {
			const [largest] = [...groups.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
			await flush(largest[0]);
		}
	}
	for (const key of [...groups.keys()]) await flush(key);

	console.log(`\n\n${index} messages in file${startAt ? `, first ${startAt} skipped` : ""}.`);
	for (const [key, count] of [...destinations.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${key}`);
	if (ignored) console.log(`  ${ignored} spam/trash messages skipped by option`);
	if (tooLarge) console.log(`  ${tooLarge} messages over 24 MB skipped (Mailflare's upload size limit)`);
	if (!values["dry-run"]) {
		console.log(`Imported ${totals.imported}, skipped ${totals.skipped} (already present or failed).`);
		if (totals.errors.length) {
			console.log(`${totals.errors.length} errors, first ones:`);
			for (const error of totals.errors.slice(0, 20)) console.log(`  ${error}`);
		}
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`\n${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
}
