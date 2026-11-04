import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { domains, mailboxes, users } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getAvatarImageResponse, getOptimizedAvatarFiles, storeAvatarImages } from "@/lib/avatar-images";
import { getMailboxSettingsAccess } from "@/lib/mailboxes/settings-access";
import { avatarKeyFor } from "@/app/api/profile/avatar/utils";
import { tracksAccountIdentity } from "@/lib/profile/identity-utils";
import { syncPersonalIdentity } from "@/lib/profile/sync";
import type { MailboxAvatarRouteParams } from "./types";
import { mailboxAvatarKeyFor } from "./utils";

export async function GET(request: Request, { params }: MailboxAvatarRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const access = await getMailboxSettingsAccess(env, user, id);
	if (!access?.canRead) return new Response("Not found", { status: 404 });

	const [mailbox] = await db
		.select({
			avatarKey: mailboxes.avatarKey,
			type: mailboxes.type,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
			ownerEmail: users.email,
			ownerAvatarKey: users.avatarKey,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, id))
		.limit(1);
	const avatarKey = mailbox && tracksAccountIdentity(mailbox, mailbox.ownerEmail)
		? mailbox.ownerAvatarKey
		: mailbox?.avatarKey;
	if (!avatarKey) return new Response("Not found", { status: 404 });

	return getAvatarImageResponse(request, env.BUCKET, avatarKey);
}

export async function POST(request: Request, { params }: MailboxAvatarRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const access = await getMailboxSettingsAccess(env, user, id);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
	}
	const images = getOptimizedAvatarFiles(form);
	if (!images) return NextResponse.json({ error: "A resized WebP image and preview are required" }, { status: 400 });

	const [mailbox] = await db
		.select({
			userId: mailboxes.userId,
			type: mailboxes.type,
			localPart: mailboxes.localPart,
			hostname: domains.hostname,
			ownerName: users.name,
			ownerEmail: users.email,
		})
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.innerJoin(users, eq(mailboxes.userId, users.id))
		.where(eq(mailboxes.id, id))
		.limit(1);
	if (!mailbox) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });

	// The primary mailbox shares the account avatar; every other mailbox stores its own.
	const identity = tracksAccountIdentity(mailbox, mailbox.ownerEmail);
	const key = identity ? avatarKeyFor(mailbox.userId) : mailboxAvatarKeyFor(id);
	await storeAvatarImages(env.BUCKET, key, images.full, images.preview);
	if (identity) {
		await syncPersonalIdentity(db, {
			userId: mailbox.userId,
			name: mailbox.ownerName,
			avatarKey: key,
		});
	} else {
		await db.update(mailboxes).set({ avatarKey: key }).where(eq(mailboxes.id, id));
	}
	return NextResponse.json({ ok: true });
}
