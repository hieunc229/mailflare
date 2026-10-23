/**
 * Imports a Google Takeout Gmail export (.mbox) into a Mailflare mailbox from the command line. The import
 * page (Settings → Import → Google Takeout) does the same in the browser, straight from the Takeout zip.
 *
 *   node scripts/import-gmail-takeout.mjs \
 *     --url https://mailflare.example.workers.dev \
 *     --mailbox you@example.com \
 *     --file "All mail Including Spam and Trash.mbox"
 *
 * Needs Node 22.18 or newer: the import logic is shared with the app and loaded from
 * src/lib/import/gmail-takeout-utils.ts through Node's built-in type stripping.
 *
 * The file is streamed, so its size does not matter. Gmail labels decide where each message lands: Inbox,
 * Sent, Drafts, Spam and Trash map to those sections, other labels become folders (first matching label
 * wins), and mail without either is archived. Unread and Starred carry over. Uploads skip duplicates, so an
 * interrupted run can simply be started again.
 *
 * Sign-in: set MAILFLARE_TOKEN to a session token (DevTools → Application → Local Storage →
 * mailflare-session-token), or pass --email and enter the password (and a 2FA code) when asked.
 * MAILFLARE_PASSWORD skips the prompt.
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
import { runTakeoutImport, splitMbox } from "../src/lib/import/gmail-takeout-utils.ts";

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

	async findFolder(mailboxId, name) {
		const { response, data } = await this.request(`/api/folders?mailboxId=${encodeURIComponent(mailboxId)}`);
		if (!response.ok) throw new Error(`Could not list folders (${response.status}): ${data.error ?? ""}`);
		return (data.folders ?? []).find((folder) => folder.name.toLowerCase() === name.toLowerCase())?.id;
	}

	async resolveFolder(mailboxId, name) {
		const existing = await this.findFolder(mailboxId, name);
		if (existing) return existing;
		const { response, data } = await this.request("/api/folders", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mailboxId, name }),
		});
		if (response.ok && data.id) return data.id;
		const created = response.status === 409 ? await this.findFolder(mailboxId, name) : undefined;
		if (created) return created;
		throw new Error(`Could not create folder ${name} (${response.status}): ${JSON.stringify(data.error ?? "")}`);
	}

	async upload(mailboxId, destination, messages, signal) {
		const form = new FormData();
		form.set("mailboxId", mailboxId);
		form.set("destination", destination);
		form.set("flags", JSON.stringify(Object.fromEntries(messages.map((message) => [message.filename, { read: message.read, starred: message.starred }]))));
		for (const message of messages) {
			form.append("files", new Blob([message.raw], { type: "message/rfc822" }), message.filename);
		}
		const { response, data } = await this.request("/api/import/messages", { method: "POST", body: form, signal });
		return { status: response.status, data };
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
	const dryRun = values["dry-run"];
	const fileSize = statSync(values.file).size;

	let client = null;
	let mailboxId = null;
	if (!dryRun) {
		if (!values.url || !values.mailbox) throw new Error("--url and --mailbox are required");
		client = process.env.MAILFLARE_TOKEN
			? new MailflareClient(values.url, process.env.MAILFLARE_TOKEN)
			: await MailflareClient.signIn(values.url, values.email ?? values.mailbox);
		mailboxId = (await client.findMailbox(values.mailbox)).id;
		console.log(`Importing ${values.file} (${formatBytes(fileSize)}) into ${values.mailbox} (${mailboxId})`);
	}

	let readBytes = 0;
	async function* countBytes(stream) {
		for await (const chunk of stream) {
			readBytes += chunk.length;
			yield chunk;
		}
	}

	const summary = await runTakeoutImport(splitMbox(countBytes(createReadStream(values.file))), {
		labels: { folders: !values["no-folders"], ignore: values["ignore-label"] },
		skipSpam: values["skip-spam"],
		skipTrash: values["skip-trash"],
		startAt: Math.max(0, Number(values["start-at"]) || 0),
		dryRun,
		upload: client ? (destination, messages, signal) => client.upload(mailboxId, destination, messages, signal) : undefined,
		resolveFolder: client ? (name) => client.resolveFolder(mailboxId, name) : undefined,
		onProgress: (progress) => {
			const percent = fileSize ? Math.min(100, (readBytes / fileSize) * 100).toFixed(1) : "100";
			process.stdout.write(`\r${progress.read} messages read (${percent}%), ${progress.imported} imported, ${progress.skipped} skipped   `);
		},
	});

	console.log(`\n\n${summary.read} messages in file.`);
	for (const [key, count] of Object.entries(summary.destinations).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(7)}  ${key}`);
	if (summary.ignored) console.log(`  ${summary.ignored} spam/trash messages skipped by option`);
	if (summary.tooLarge) console.log(`  ${summary.tooLarge} messages over 24 MB skipped (Mailflare's upload size limit)`);
	if (!dryRun) {
		console.log(`Imported ${summary.imported}, skipped ${summary.skipped} (already present).`);
		if (summary.failed) {
			console.log(`${summary.failed} failed, first ones:`);
			for (const error of summary.errors.slice(0, 20)) console.log(`  ${error}`);
		}
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main().catch((error) => {
		console.error(`\n${error instanceof Error ? error.message : error}`);
		process.exit(1);
	});
}
