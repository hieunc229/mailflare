import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { driveItems, driveShares, users } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { getAvatarImageResponse } from "@/lib/avatar-images";
import { driveAccessError } from "@/lib/drive/auth";
import type { DriveItemParams } from "../../../items/[id]/types";

/** Avatar of a Drive owner. Only yourself, or someone who shared something with you, is visible. */
export async function GET(request: Request, { params }: DriveItemParams) {
	const { id } = await params;
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const denied = driveAccessError(user);
	if (denied) return denied;
	const db = getDb(env);
	if (id !== user.id) {
		const [shared] = await db.select({ id: driveShares.id }).from(driveShares).innerJoin(driveItems, eq(driveShares.itemId, driveItems.id)).where(and(eq(driveShares.userId, user.id), eq(driveItems.ownerId, id))).limit(1);
		if (!shared) return new Response("Not found", { status: 404 });
	}
	const [owner] = await db.select({ avatarKey: users.avatarKey }).from(users).where(eq(users.id, id)).limit(1);
	if (!owner?.avatarKey) return new Response("Not found", { status: 404 });
	return getAvatarImageResponse(request, env.BUCKET, owner.avatarKey);
}
