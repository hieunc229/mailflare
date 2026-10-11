import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { withStorage } from "@/lib/storage";
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
	const agentQueue = openQueue("mailflare-agent");
	const realtime = new RealtimeHubRegistry();
	const publicDir = resolve(optional("PUBLIC_DIR") ?? "./public");

	const env = {
		DB: database,
		BUCKET: bucket,
		EMAIL: mailer,
		INBOUND_QUEUE: inboundQueue,
		OUTBOUND_QUEUE: outboundQueue,
		AGENT_QUEUE: agentQueue,
		AI_MODEL: optional("AI_MODEL"),
		AI_BASE_URL: optional("AI_BASE_URL"),
		AI_API_KEY: optional("AI_API_KEY"),
		REALTIME: realtime.namespace(),
		ASSETS: openAssets(publicDir),
		IMAGES: undefined as unknown as CloudflareEnv["IMAGES"],
		WORKER_SELF_REFERENCE: undefined as unknown as CloudflareEnv["WORKER_SELF_REFERENCE"],
		LOGIN_RATE_LIMIT: openRateLimiter(20, 60),
		AGENT_RATE_LIMIT: openRateLimiter(120, 60),
		B2_KEY_ID: optional("B2_KEY_ID"),
		B2_APPLICATION_KEY: optional("B2_APPLICATION_KEY"),
		B2_BUCKET: optional("B2_BUCKET"),
		B2_ENDPOINT: optional("B2_ENDPOINT"),
		S3_BUCKET: optional("S3_BUCKET"),
		S3_REGION: optional("S3_REGION") ?? optional("AWS_REGION"),
		S3_ACCESS_KEY_ID: optional("S3_ACCESS_KEY_ID") ?? optional("AWS_ACCESS_KEY_ID"),
		S3_SECRET_ACCESS_KEY: optional("S3_SECRET_ACCESS_KEY") ?? optional("AWS_SECRET_ACCESS_KEY"),
		CF_TOKEN: optional("CF_TOKEN"),
		CF_API_KEY: optional("CF_API_KEY"),
		CF_EMAIL: optional("CF_EMAIL"),
		TURNSTILE_SECRET_KEY: optional("TURNSTILE_SECRET_KEY"),
		SETUP_TOKEN: optional("SETUP_TOKEN"),
		// Without SETUP_TOKEN the setup code is derived from this, printed at start, and changes on restart.
		SETUP_CODE_SECRET: crypto.randomUUID(),
		GITHUB_UPDATE_TOKEN: optional("GITHUB_UPDATE_TOKEN"),
		GITHUB_UPDATE_REF: optional("GITHUB_UPDATE_REF"),
		GITHUB_UPDATE_REPO: optional("GITHUB_UPDATE_REPO"),
		// Marks the runtime for the few places that must behave differently.
		MAILFLARE_RUNTIME: "node",
		APP_URL: optional("APP_URL")?.replace(/\/$/, ""),
		INBOUND_WEBHOOK_SECRET: optional("INBOUND_WEBHOOK_SECRET"),
		VAPID_PUBLIC_KEY: optional("VAPID_PUBLIC_KEY"),
		VAPID_PRIVATE_KEY: optional("VAPID_PRIVATE_KEY"),
		VAPID_SUBJECT: optional("VAPID_SUBJECT"),
	} as unknown as CloudflareEnv;
	const storageEnv = withStorage(env);
	realtime.bindEnv(storageEnv);

	return {
		env: storageEnv,
		dataDir,
		database: database as unknown as SqliteDatabase,
		mailer: mailer as unknown as Mailer,
		inboundQueue: inboundQueue as unknown as InProcessQueue,
		outboundQueue: outboundQueue as unknown as InProcessQueue,
		agentQueue: agentQueue as unknown as InProcessQueue,
		realtime,
	};
}
