import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { webhookDeliveries, webhooks } from "@/db/schema";
import { newId } from "@/lib/ids";

export type WebhookEventType = "message.inbound" | "message.outbound" | "message.failed";

export async function dispatchWebhooks(
	env: CloudflareEnv,
	userId: string,
	eventType: WebhookEventType,
	payload: Record<string, unknown>,
): Promise<void> {
	const db = getDb(env);
	const hooks = await db.select().from(webhooks).where(eq(webhooks.userId, userId));

	for (const hook of hooks) {
		if (!hook.enabled) continue;
		let events: string[] = [];
		try {
			events = JSON.parse(hook.events) as string[];
		} catch {
			continue;
		}
		if (!events.includes(eventType)) continue;

		const deliveryId = newId();
		const body = JSON.stringify({ type: eventType, data: payload });
		await db.insert(webhookDeliveries).values({
			id: deliveryId,
			webhookId: hook.id,
			eventType,
			payload: body,
			status: "pending",
			attempts: 0,
		});

		try {
			const signature = await signPayload(hook.secret, body);
			const res = await fetch(hook.url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Email-Platform-Signature": signature,
					"X-Email-Platform-Event": eventType,
				},
				body,
			});
			await db
				.update(webhookDeliveries)
				.set({ status: res.ok ? "delivered" : "failed", attempts: 1 })
				.where(eq(webhookDeliveries.id, deliveryId));
		} catch {
			await db
				.update(webhookDeliveries)
				.set({ status: "failed", attempts: 1 })
				.where(eq(webhookDeliveries.id, deliveryId));
		}
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
