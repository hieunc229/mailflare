import { getDatabaseConfig } from "@/db/with-database";
import { hasCloudflareCredentials, isNodeRuntime, isVercelRuntime } from "@/lib/runtime";
import type { SetupRequirementCheck } from "./types";

export function getSetupRequirementChecks(env: CloudflareEnv): SetupRequirementCheck[] {
	const hasApiToken = !!env.CF_TOKEN?.trim();
	const hasGlobalKey = !!env.CF_API_KEY?.trim() && !!env.CF_EMAIL?.trim();

	const database = getDatabaseConfig(env);
	if (isNodeRuntime(env)) {
		const mailer = env.EMAIL as unknown as { configured?: boolean };
		return [
			{
				key: "Database",
				configured: !!env.DB,
				message: database.driver === "d1" ? "DATA_DIR must be writable; the SQLite database is created there on start." : "DATABASE_URL must be reachable; migrations are applied on start.",
			},
			{
				key: "Outbound mail",
				configured: mailer?.configured === true,
				message: "Set SMTP_URL, or CF_ACCOUNT_ID with CF_TOKEN to send through Cloudflare. Receiving works without it.",
			},
			{
				key: "Cloudflare API credentials (optional)",
				configured: true,
				message: hasCloudflareCredentials(env)
					? "Domains are provisioned on Cloudflare automatically."
					: "Not set: add MX and SPF records for each domain by hand, as shown on the domain page.",
			},
		];
	}

	// The Vercel runtime refuses to start without its database and storage, so reaching this check means they
	// are set; what can still be missing is outbound mail.
	if (isVercelRuntime(env)) {
		const mailer = env.EMAIL as unknown as { configured?: boolean };
		return [
			{ key: "Database", configured: !!env.DB, message: "Set DATABASE_URL to PostgreSQL, MySQL or Turso, or connect Turso to the Vercel project." },
			{ key: "Object storage", configured: !!env.BUCKET, message: "Connect a private Vercel Blob store, or set S3_BUCKET, S3_REGION and credentials, or the four B2_* variables." },
			// Never blocks setup: Resend and Amazon SES are connected from the Domains page afterwards.
			{
				key: "Outbound mail (optional)",
				configured: true,
				message: mailer?.configured === true
					? "SMTP or Cloudflare Email Sending is configured."
					: "Set SMTP_URL, or CF_ACCOUNT_ID with CF_TOKEN, or add Resend or Amazon SES on the Domains page after setup.",
			},
		];
	}

	return [
		{
			key: "Cloudflare API credentials",
			configured: hasApiToken || hasGlobalKey,
			message: "Set CF_TOKEN, or set both CF_API_KEY and CF_EMAIL.",
		},
		{
			key: database.driver === "d1" ? "D1 database" : "Database",
			configured: !!env.DB,
			message: database.driver === "d1" ? "Deploy the Worker with the DB binding from wrangler.jsonc." : "Check DATABASE_URL (and DATABASE_DRIVER) for the external database.",
		},
	];
}
