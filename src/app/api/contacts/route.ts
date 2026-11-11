import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { contacts } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { deleteAvatarImages } from "@/lib/avatar-images";
import { getEnv } from "@/lib/cloudflare";
import { normalizeEmailAddress } from "@/lib/email/address";
import { importGravatarAvatar } from "@/lib/contacts/gravatar";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { getPersonalIdentityForAddress, syncPersonalIdentity } from "@/lib/profile/sync";
import { parseAddress } from "@/lib/utils";
import type { ContactRequestInput } from "./types";
import { getContactByEmail, listContacts, parseContactsLimit, saveManualContact, toContactDetails } from "./utils";

export async function GET(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const email = normalizeEmailAddress(url.searchParams.get("address") ?? "");
	if (!mailboxId) {
		return NextResponse.json({ error: "Mailbox and contact are required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canRead) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	// No address means a listing: the search box on the Contacts page and the
	// composer's suggestions both read this shape.
	if (!email) {
		const rows = await listContacts(db, {
			userId: access.mailbox.userId,
			query: (url.searchParams.get("q") ?? "").trim(),
			limit: parseContactsLimit(url.searchParams.get("limit")),
		});
		return NextResponse.json({
			contacts: rows.map((contact) => toContactDetails(contact)),
		});
	}

	const storedContact = toContactDetails(await getContactByEmail(db, access.mailbox.userId, email));
	const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, email);
	const contact = account
		? {
				...(storedContact ?? {}),
				email,
				displayName: account.name,
				hasAvatar: !!account.avatarKey,
				source: "manual" as const,
				blocked: storedContact?.blocked ?? false,
				lastSeenAt: storedContact?.lastSeenAt ?? null,
			}
		: storedContact;
	return NextResponse.json({
		contact: contact ?? {
			email,
			displayName: null,
			hasAvatar: false,
			source: null,
			blocked: false,
			lastSeenAt: null,
		},
	});
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const body = (await request.json()) as ContactRequestInput;
	const email = normalizeEmailAddress(body.address ?? "");
	const displayName = body.displayName?.trim() || null;
	if (!body.mailboxId || !parseAddress(email) || (displayName && displayName.length > 100)) {
		return NextResponse.json({ error: "A valid contact is required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, body.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	// The address can be one of the user's own accounts; keep its name in step like PATCH does.
	const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, email);
	if (account && account.userId === user.id && displayName) {
		await syncPersonalIdentity(db, {
			userId: account.userId,
			name: displayName,
			avatarKey: account.avatarKey,
		});
	}
	const existing = await getContactByEmail(db, access.mailbox.userId, email);
	const saved = await saveManualContact(db, {
		userId: access.mailbox.userId,
		email,
		displayName,
	});
	if (!existing && saved) {
		const avatarKey = await importGravatarAvatar(env, access.mailbox.userId, email);
		if (avatarKey) {
			await db.update(contacts).set({ avatarKey }).where(eq(contacts.id, saved.id));
			return NextResponse.json({ contact: { ...toContactDetails(saved), hasAvatar: true } });
		}
	}
	return NextResponse.json({ contact: toContactDetails(saved) });
}

export async function PATCH(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const body = (await request.json()) as ContactRequestInput;
	const email = normalizeEmailAddress(body.address ?? "");
	const displayName = body.displayName?.trim() ?? "";
	if (!body.mailboxId || !email || !displayName || displayName.length > 100) {
		return NextResponse.json({ error: "A valid contact name is required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, body.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const account = await getPersonalIdentityForAddress(db, access.mailbox.userId, email);
	if (account) {
		if (account.userId !== user.id) {
			return NextResponse.json({ error: "Only the account owner can change this contact" }, { status: 403 });
		}
		await syncPersonalIdentity(db, {
			userId: account.userId,
			name: displayName,
			avatarKey: account.avatarKey,
		});
	}
	const contact = toContactDetails(await saveManualContact(db, {
		userId: access.mailbox.userId,
		email,
		displayName,
	}));
	return NextResponse.json({ contact });
}

export async function DELETE(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const email = normalizeEmailAddress(url.searchParams.get("address") ?? "");
	if (!mailboxId || !email) {
		return NextResponse.json({ error: "Mailbox and contact are required" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const existing = await getContactByEmail(db, access.mailbox.userId, email);
	if (existing?.avatarKey) {
		await deleteAvatarImages(env.BUCKET, existing.avatarKey);
	}
	await db
		.delete(contacts)
		.where(and(eq(contacts.userId, access.mailbox.userId), eq(contacts.email, email)));
	return NextResponse.json({ ok: true });
}
