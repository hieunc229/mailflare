import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import type { AppDatabase } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { newId } from "@/lib/ids";
import { assertResolvesPublic, isPublicHttpsUrl, PUBLIC_HTTPS_URL_MESSAGE } from "@/lib/security/public-url";

export type WebhookEventType = "message.inbound" | "message.outbound" | "message.failed";

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
	"message.inbound",
	"message.outbound",
	"message.failed",
];

/** Retry work is carried on the existing outbound queue so no new binding is required. */
export type WebhookRetryMessage = {
	kind: "webhook.retry";
	deliveryId: string;
};

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed" | "retrying" | "exhausted";

type WebhookRow = typeof webhooks.$inferSelect;
type DeliveryRow = typeof webhookDeliveries.$inferSelect;

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SNIPPET = 500;

/** Exponential backoff, capped at one hour: 1m, 2m, 4m, 8m, 16m... */
export function getRetryDelaySeconds(attempt: number): number {
	return Math.min(60 * 2 ** Math.max(attempt - 1, 0), 3600);
}

export function parseWebhookEvents(events: string): string[] {
	try {
		const parsed = JSON.parse(events);
		return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
	} catch {
		return [];
	}
}

export async function dispatchWebhooks(
	env: CloudflareEnv,
	userId: string,
	eventType: WebhookEventType,
	payload: Record<string, unknown>,
): Promise<void> {
	const db = getDb(env);
	const hooks = await db.select().from(webhooks).where(eq(webhooks.userId, userId));

	const matching = hooks.filter((hook) => hook.enabled && parseWebhookEvents(hook.events).includes(eventType));
	const body = JSON.stringify({ type: eventType, data: payload });
	// The first attempt runs in the queue consumer, so a send or an inbound message never waits on customer endpoints.
	await Promise.allSettled(matching.map(async (hook) => {
		try {
			const delivery = await createDelivery(db, hook.id, eventType, body, { queued: true });
			try {
				await env.OUTBOUND_QUEUE.send({ kind: "webhook.retry", deliveryId: delivery.id } satisfies WebhookRetryMessage);
			} catch (error) {
				console.error(`Failed to enqueue webhook delivery ${delivery.id}, attempting inline`, error);
				await attemptDelivery(env, db, hook, delivery);
			}
		} catch (error) {
			console.error(`Webhook dispatch failed for ${hook.id}`, error);
		}
	}));
}

type PendingDelivery = Pick<DeliveryRow, "id" | "payload" | "eventType" | "attempts">;

async function createDelivery(
	db: AppDatabase,
	webhookId: string,
	eventType: string,
	payload: string,
	options?: { queued?: boolean },
): Promise<PendingDelivery> {
	const id = newId("whd");
	await db.insert(webhookDeliveries).values({
		id,
		webhookId,
		eventType,
		payload,
		// A queued first attempt is a retry the consumer picks up now; it only posts deliveries in that state.
		status: options?.queued ? "retrying" : "pending",
		attempts: 0,
		...(options?.queued ? { nextRetryAt: new Date() } : {}),
	});
	return { id, payload, eventType, attempts: 0 };
}

/** Runs one delivery attempt and records the outcome, scheduling a retry when it fails. */
async function attemptDelivery(
	env: CloudflareEnv,
	db: AppDatabase,
	hook: WebhookRow,
	delivery: PendingDelivery,
	options?: { scheduleNext?: boolean },
): Promise<WebhookDeliveryStatus> {
	const attempts = delivery.attempts + 1;
	const startedAt = Date.now();
	const now = new Date();

	let responseStatus: number | null = null;
	let error: string | null = null;

	try {
		// Hooks saved before URL validation existed must not become an SSRF path.
		if (!isPublicHttpsUrl(hook.url)) throw new Error(PUBLIC_HTTPS_URL_MESSAGE);
		await assertResolvesPublic(new URL(hook.url).hostname);
		const signature = await signPayload(hook.secret, delivery.payload);
		const res = await fetch(hook.url, {
			method: "POST",
			redirect: "manual",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: {
				"Content-Type": "application/json",
				"X-Email-Platform-Signature": signature,
				"X-Email-Platform-Event": delivery.eventType,
				"X-Email-Platform-Delivery": delivery.id,
				"X-Email-Platform-Attempt": String(attempts),
			},
			body: delivery.payload,
		});
		responseStatus = res.status;
		if (!res.ok) {
			error = (await readResponseSnippet(res)) || `Endpoint responded with ${res.status}`;
		}
	} catch (err) {
		error = err instanceof Error ? err.message : "Request failed";
	}

	const durationMs = Date.now() - startedAt;
	const delivered = !error;
	const canRetry = !delivered && attempts < hook.maxAttempts;
	const status: WebhookDeliveryStatus = delivered ? "delivered" : canRetry ? "retrying" : "exhausted";
	const nextRetryAt = canRetry ? new Date(Date.now() + getRetryDelaySeconds(attempts) * 1000) : null;

	await db
		.update(webhookDeliveries)
		.set({
			status,
			attempts,
			responseStatus,
			error: error ? error.slice(0, MAX_RESPONSE_SNIPPET) : null,
			durationMs,
			lastAttemptAt: now,
			nextRetryAt,
		})
		.where(eq(webhookDeliveries.id, delivery.id));

	// A manual retry made while a queued retry is still pending leaves that one in place: no second chain.
	if (canRetry && options?.scheduleNext !== false) {
		await scheduleRetry(env, delivery.id, getRetryDelaySeconds(attempts));
	}

	return status;
}

async function scheduleRetry(env: CloudflareEnv, deliveryId: string, delaySeconds: number): Promise<void> {
	const message: WebhookRetryMessage = { kind: "webhook.retry", deliveryId };
	try {
		await env.OUTBOUND_QUEUE.send(message, { delaySeconds });
	} catch (error) {
		console.error(`Failed to schedule webhook retry for ${deliveryId}`, error);
	}
}

/** Queue consumer entry point for scheduled retries. */
export async function processWebhookRetry(
	env: CloudflareEnv,
	message: WebhookRetryMessage,
): Promise<void> {
	await runDelivery(env, message.deliveryId, { scheduled: true });
}

/**
 * Runs (or re-runs) a delivery. Used by the retry queue and by the manual retry button.
 * Returns null when the delivery or its webhook no longer exists.
 */
export async function runDelivery(
	env: CloudflareEnv,
	deliveryId: string,
	options?: { userId?: string; scheduled?: boolean },
): Promise<{ status: WebhookDeliveryStatus } | null> {
	const db = getDb(env);
	const [delivery] = await db
		.select()
		.from(webhookDeliveries)
		.where(eq(webhookDeliveries.id, deliveryId))
		.limit(1);
	if (!delivery) return null;

	const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).limit(1);
	if (!hook) return null;
	if (options?.userId && hook.userId !== options.userId) return null;
	// A queued retry only applies to a delivery still waiting for one: a manual retry may have settled it since.
	if (options?.scheduled && delivery.status !== "retrying") return { status: delivery.status as WebhookDeliveryStatus };
	// Retries queued before the webhook was switched off must not keep posting to it.
	// A manual retry is still allowed; it is the operator asking for it.
	if (options?.scheduled && !hook.enabled) {
		await db
			.update(webhookDeliveries)
			.set({ status: "failed", error: "Webhook is disabled", nextRetryAt: null })
			.where(eq(webhookDeliveries.id, delivery.id));
		return { status: "failed" };
	}

	const chainPending = !options?.scheduled && delivery.status === "retrying" && !!delivery.nextRetryAt && delivery.nextRetryAt.getTime() > Date.now();
	return { status: await attemptDelivery(env, db, hook, delivery, { scheduleNext: !chainPending }) };
}

/** Sends a synthetic event so an operator can verify an endpoint from the UI. */
export async function sendTestDelivery(
	env: CloudflareEnv,
	hook: WebhookRow,
): Promise<{ deliveryId: string; status: WebhookDeliveryStatus }> {
	const db = getDb(env);
	const body = JSON.stringify({
		type: "message.inbound",
		test: true,
		data: {
			messageId: "test",
			from: "postmaster@example.com",
			to: "inbox@example.com",
			subject: "Mailflare test delivery",
		},
	});
	const delivery = await createDelivery(db, hook.id, "message.inbound", body);
	const status = await attemptDelivery(env, db, hook, delivery);
	return { deliveryId: delivery.id, status };
}

async function readResponseSnippet(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.trim().slice(0, MAX_RESPONSE_SNIPPET);
	} catch {
		return "";
	}
}

async function signPayload(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
