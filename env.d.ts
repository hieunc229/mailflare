interface CloudflareEnv {
	DB: D1Database;
	EMAIL: SendEmail;
	BUCKET: R2Bucket;
	INBOUND_QUEUE: Queue<import("./src/lib/email/inbound").InboundQueueMessage>;
	OUTBOUND_QUEUE: Queue<import("./src/lib/email/send").OutboundQueueMessage>;
	ASSETS: Fetcher;
	IMAGES: ImagesBinding;
	WORKER_SELF_REFERENCE: Fetcher;
	CF_TOKEN?: string;
	CLOUDFLARE_API_KEY?: string;
	CLOUDFLARE_EMAIL?: string;
	CF_ACCOUNT_ID?: string;
	CF_EMAIL_WORKER_NAME?: string;
}
