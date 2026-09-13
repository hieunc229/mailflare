import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openFileBucket } from "./file-bucket";
import { openMailer, type Mailer, type MailerConfig } from "./mailer";
import { openAssets, openRateLimiter } from "./misc";
import { openQueue, type InProcessQueue } from "./queue";
import { RealtimeHubRegistry } from "./realtime";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite-database";
import type { NodeRuntime } from "./types";

function optional(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value || undefined;
}

function mailerConfig(): MailerConfig {
	const smtp = optional("SMTP_URL");
	if (smtp) return { kind: "smtp", url: smtp };
	const accountId = optional("CF_ACCOUNT_ID");
	const token = optional("CF_TOKEN");
	if (accountId && token) return { kind: "cloudflare", accountId, token };
	return { kind: "none" };
}

/**
 * Assemble a `CloudflareEnv` for the Node runtime from environment variables
 * and local resources. Everything the app reaches through `getEnv()` is here,
 * so application code does not know which platform it runs on.
 */
export function createNodeRuntime(): NodeRuntime {
	const dataDir = resolve(optional("DATA_DIR") ?? "./data");
	mkdirSync(join(dataDir, "blobs"), { recursive: true });

	const database = openSqliteDatabase(join(dataDir, "mailflare.sqlite"));
	const bucket = openFileBucket(join(dataDir, "blobs"));
	const mailer = openMailer(mailerConfig());
	const inboundQueue = openQueue("mailflare-inbound");
	const outboundQueue = openQueue("mailflare-outbound");
	const realtime = new RealtimeHubRegistry();
	const publicDir = resolve(optional("PUBLIC_DIR") ?? "./public");

	const env = {
		DB: database,
		BUCKET: bucket,
		EMAIL: mailer,
		INBOUND_QUEUE: inboundQueue,
		OUTBOUND_QUEUE: outboundQueue,
		REALTIME: realtime.namespace(),
		ASSETS: openAssets(publicDir),
		IMAGES: undefined as unknown as CloudflareEnv["IMAGES"],
		WORKER_SELF_REFERENCE: undefined as unknown as CloudflareEnv["WORKER_SELF_REFERENCE"],
		LOGIN_RATE_LIMIT: openRateLimiter(20, 60),
		CF_TOKEN: optional("CF_TOKEN"),
		CF_API_KEY: optional("CF_API_KEY"),
		CF_EMAIL: optional("CF_EMAIL"),
		TURNSTILE_SECRET_KEY: optional("TURNSTILE_SECRET_KEY"),
		GITHUB_UPDATE_TOKEN: optional("GITHUB_UPDATE_TOKEN"),
		GITHUB_UPDATE_REF: optional("GITHUB_UPDATE_REF"),
		GITHUB_UPDATE_REPO: optional("GITHUB_UPDATE_REPO"),
		// Marks the runtime for the few places that must behave differently.
		MAILFLARE_RUNTIME: "node",
		APP_URL: optional("APP_URL")?.replace(/\/$/, ""),
		INBOUND_WEBHOOK_SECRET: optional("INBOUND_WEBHOOK_SECRET"),
	} as unknown as CloudflareEnv;

	return {
		env,
		dataDir,
		database: database as unknown as SqliteDatabase,
		mailer: mailer as unknown as Mailer,
		inboundQueue: inboundQueue as unknown as InProcessQueue,
		outboundQueue: outboundQueue as unknown as InProcessQueue,
		realtime,
	};
}
