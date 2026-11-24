import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { isPublicHttps } from "@/lib/domains/resend-receiving";
import { getResendClient } from "@/lib/email/outbound-provider";
import { createResendWebhook, deleteResendWebhook, listResendWebhooks } from "@/lib/email/resend-api";
import { getResendEventsSecret } from "./provider-events";

export const resendEventsUrl = (origin: string) => `${origin.replace(/\/$/, "")}/api/provider-events/resend`;
const EVENTS = ["email.bounced", "email.complained"];

async function store(env: CloudflareEnv, id: string | null, secret: string | null): Promise<void> {
	const values = { resendEventsWebhookId: id, resendEventsWebhookSecret: secret, updatedAt: new Date() };
	await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
}

/**
 * Registers a second Resend webhook, separate from the receiving one, for bounces and complaints.
 * Resend shows the signing secret only at creation, so a hook we hold no secret for is replaced.
 */
export async function setupResendFeed(env: CloudflareEnv, origin: string): Promise<void> {
	if (!isPublicHttps(origin)) {
		throw new Error("Resend delivers events by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).");
	}
	const client = await getResendClient(env);
	const endpoint = resendEventsUrl(origin);
	const existing = (await listResendWebhooks(client)).find((webhook) => webhook.endpoint === endpoint);
	if (existing && await getResendEventsSecret(env)) return;
	if (existing) await deleteResendWebhook(client, existing.id);
	const created = await createResendWebhook(client, endpoint, EVENTS);
	await store(env, created.id, created.signing_secret);
}

export async function removeResendFeed(env: CloudflareEnv): Promise<void> {
	const [row] = await getDb(env).select({ id: appSettings.resendEventsWebhookId }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
	if (row?.id) await deleteResendWebhook(await getResendClient(env), row.id).catch(() => undefined);
	await store(env, null, null);
}
