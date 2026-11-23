import { and, eq, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { sharedAttachmentLinks } from "@/db/schema";
import { newId } from "@/lib/ids";

export const SHARED_ATTACHMENT_LINK_DAYS = 30;

export async function getOrCreateSharedAttachmentUrl(
	env: CloudflareEnv,
	attachmentId: string,
	publicOrigin?: string,
	days: number = SHARED_ATTACHMENT_LINK_DAYS,
): Promise<string> {
	const origin = env.APP_URL?.trim() || publicOrigin;
	if (!origin) throw new Error("Set APP_URL before sending large attachments as download links");
	const url = new URL(origin);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
		throw new Error("A public HTTPS APP_URL is required for large attachment links");
	}
	const db = getDb(env);
	const now = new Date();
	await db.delete(sharedAttachmentLinks).where(and(eq(sharedAttachmentLinks.attachmentId, attachmentId), lte(sharedAttachmentLinks.expiresAt, now)));
	const id = newId("share");
	await db.insert(sharedAttachmentLinks).values({
		id,
		attachmentId,
		expiresAt: new Date(now.getTime() + days * 24 * 60 * 60_000),
	}).onConflictDoNothing();
	const [link] = await db.select({ id: sharedAttachmentLinks.id }).from(sharedAttachmentLinks).where(eq(sharedAttachmentLinks.attachmentId, attachmentId)).limit(1);
	if (!link) throw new Error("Could not create a large attachment link");
	return new URL(`/api/shared-files/${encodeURIComponent(link.id)}`, url).toString();
}
