import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { deleteAvatarImages, getAvatarImageResponse, getOptimizedAvatarFiles, storeAvatarImages } from "@/lib/avatar-images";
import { getContactId } from "@/lib/contacts/utils";
import { normalizeEmailAddress } from "@/lib/email/address";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { avatarKeyFor } from "@/app/api/profile/avatar/utils";
import { getPersonalIdentityForAddress, syncPersonalIdentity } from "@/lib/profile/sync";
import { contactAvatarKeyFor } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const email = normalizeEmailAddress(url.searchParams.get("address") ?? "");
	if (!mailboxId || !email) return new Response("Not found", { status: 404 });

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) return new Response("Not found", { status: 404 });
	const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, email);
	const [contact] = await db
		.select({ avatarKey: contacts.avatarKey })
		.from(contacts)
		.where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email)))
		.limit(1);
	const avatarKey = account ? account.avatarKey : contact?.avatarKey;
	// Uploading an avatar changes the URL's version, so a cached miss never hides a new one.
	if (!avatarKey) return new Response("Not found", { status: 404, headers: { "Cache-Control": "private, max-age=600" } });

	return getAvatarImageResponse(request, env.BUCKET, avatarKey);
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return NextResponse.json({ error: "Expected multipart form data" }, { status: 400 });
	}
	const mailboxEntry = form.get("mailboxId");
	const addressEntry = form.get("address");
	const mailboxId = typeof mailboxEntry === "string" ? mailboxEntry : "";
	const email = normalizeEmailAddress(typeof addressEntry === "string" ? addressEntry : "");
	const images = getOptimizedAvatarFiles(form);
	if (!mailboxId || !email || !images) {
		return NextResponse.json({ error: "Mailbox, contact, and image file are required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, email);
	if (account) {
		if (account.userId !== user.id) {
			return NextResponse.json({ error: "Only the account owner can change this contact" }, { status: 403 });
		}
		const key = avatarKeyFor(account.userId);
		await storeAvatarImages(env.BUCKET, key, images.full, images.preview);
		await syncPersonalIdentity(db, { ...account, avatarKey: key });
		return NextResponse.json({ ok: true });
	}
	const [existing] = await db
		.select({ id: contacts.id })
		.from(contacts)
		.where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email)))
		.limit(1);
	if (!existing) {
		await db.insert(contacts).values({
			id: getContactId(access.mailbox.userId, email),
			userId: access.mailbox.userId,
			email,
			source: "manual",
		});
	}

	const key = contactAvatarKeyFor(access.mailbox.userId, email);
	await storeAvatarImages(env.BUCKET, key, images.full, images.preview);
	await db
		.update(contacts)
		.set({ avatarKey: key })
		.where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email)));
	return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const email = normalizeEmailAddress(url.searchParams.get("address") ?? "");
	if (!mailboxId || !email) return NextResponse.json({ error: "Mailbox and contact are required" }, { status: 400 });

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, email);
	if (account) {
		if (account.userId !== user.id) {
			return NextResponse.json({ error: "Only the account owner can change this contact" }, { status: 403 });
		}
		if (account.avatarKey) await deleteAvatarImages(env.BUCKET, account.avatarKey);
		await syncPersonalIdentity(db, { ...account, avatarKey: null });
		return NextResponse.json({ ok: true });
	}
	const [contact] = await db
		.select({ avatarKey: contacts.avatarKey })
		.from(contacts)
		.where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email)))
		.limit(1);
	if (contact?.avatarKey) await deleteAvatarImages(env.BUCKET, contact.avatarKey);
	await db
		.update(contacts)
		.set({ avatarKey: null })
		.where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email)));
	return NextResponse.json({ ok: true });
}
