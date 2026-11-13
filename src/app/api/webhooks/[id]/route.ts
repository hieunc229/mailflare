import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { webhooks } from "@/db/schema";
import { parseWebhookEvents } from "@/lib/email/webhooks";
import { webhookUpdateSchema } from "@/lib/validators";
import { loadOwnedWebhook } from "./utils";
import type { WebhookRouteParams } from "./types";
import { newId } from "@/lib/ids";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { readJsonObject } from "@/lib/http/request";

export async function GET(request: Request, { params }: WebhookRouteParams) {
	const { id } = await params;
	const loaded = await loadOwnedWebhook(request, id);
	if (loaded.error) return loaded.error;

	const { hook } = loaded;
	return NextResponse.json({
		webhook: {
			id: hook.id,
			url: hook.url,
			description: hook.description,
			events: parseWebhookEvents(hook.events),
			enabled: hook.enabled,
			maxAttempts: hook.maxAttempts,
			createdAt: hook.createdAt,
		},
	});
}

export async function PATCH(request: Request, { params }: WebhookRouteParams) {
	const { id } = await params;
	const loaded = await loadOwnedWebhook(request, id);
	if (loaded.error) return loaded.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	const parsed = webhookUpdateSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const updates: Partial<typeof webhooks.$inferInsert> = {};
	if (parsed.data.url !== undefined) updates.url = parsed.data.url;
	if (parsed.data.description !== undefined) updates.description = parsed.data.description?.trim() || null;
	if (parsed.data.events !== undefined) updates.events = JSON.stringify(parsed.data.events);
	if (parsed.data.enabled !== undefined) updates.enabled = parsed.data.enabled;
	if (parsed.data.maxAttempts !== undefined) updates.maxAttempts = parsed.data.maxAttempts;
	const secret = parsed.data.rotateSecret ? newId("whsec") : null;
	if (secret) updates.secret = secret;

	if (Object.keys(updates).length === 0) {
		return NextResponse.json({ error: "No changes provided" }, { status: 400 });
	}

	await loaded.db.update(webhooks).set(updates).where(eq(webhooks.id, id));
	return NextResponse.json({ ok: true, ...(secret ? { secret } : {}) });
}

export async function DELETE(request: Request, { params }: WebhookRouteParams) {
	const { id } = await params;
	const loaded = await loadOwnedWebhook(request, id);
	if (loaded.error) return loaded.error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	// Deliveries cascade with the webhook row.
	await loaded.db.delete(webhooks).where(eq(webhooks.id, id));
	return NextResponse.json({ ok: true });
}
