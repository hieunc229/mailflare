import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contactGroupMembers, contacts } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { normalizeEmailAddress } from "@/lib/email/address";
import { readJsonObject } from "@/lib/http/request";
import { newId } from "@/lib/ids";
import { contactGroupMemberSchema } from "@/lib/validators";
import { getContactByEmail, saveManualContact } from "../../../utils";
import type { ContactGroupRouteParams } from "../types";
import { getGroupBookOwner, getOwnedGroup, listGroupMembers } from "../../utils";

export async function GET(request: Request, { params }: ContactGroupRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const mailboxId = new URL(request.url).searchParams.get("mailboxId");
	if (!mailboxId) {
		return NextResponse.json({ error: "Mailbox is required" }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const group = await getOwnedGroup(db, userId, id);
	if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

	return NextResponse.json({ members: await listGroupMembers(db, id) });
}

/**
 * Adds a member by `contactId`, or by `email`: an address with no contact yet
 * becomes a manual contact in the book first — the same save `/api/contacts`
 * performs — then joins the group.
 */
export async function POST(request: Request, { params }: ContactGroupRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const parsed = contactGroupMemberSchema.safeParse(await readJsonObject(request));
	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, parsed.data.mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const group = await getOwnedGroup(db, userId, id);
	if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

	let contact: typeof contacts.$inferSelect | null;
	if (parsed.data.contactId) {
		const [row] = await db
			.select()
			.from(contacts)
			.where(and(eq(contacts.id, parsed.data.contactId), eq(contacts.userId, userId)))
			.limit(1);
		contact = row ?? null;
		if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
	} else {
		// The member schema's XOR refine guarantees an email when no contactId came in.
		const email = normalizeEmailAddress(parsed.data.email!);
		contact = await getContactByEmail(db, userId, email);
		contact ??= await saveManualContact(db, { userId, email });
	}

	const [existing] = await db
		.select({ id: contactGroupMembers.id })
		.from(contactGroupMembers)
		.where(and(eq(contactGroupMembers.groupId, group.id), eq(contactGroupMembers.contactId, contact.id)))
		.limit(1);
	if (existing) {
		return NextResponse.json({ error: "This contact is already in the group" }, { status: 409 });
	}

	await db.insert(contactGroupMembers).values({ id: newId("cgm"), groupId: group.id, contactId: contact.id });
	return NextResponse.json({ members: await listGroupMembers(db, id) });
}

/** Removes a member by `contactId` or `email`; the contact itself stays in the book. */
export async function DELETE(request: Request, { params }: ContactGroupRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const url = new URL(request.url);
	const mailboxId = url.searchParams.get("mailboxId");
	const contactId = url.searchParams.get("contactId");
	const emailParam = url.searchParams.get("email");
	if (!mailboxId || (!contactId && !emailParam) || (contactId && emailParam)) {
		return NextResponse.json({ error: "Mailbox and one of contactId or email are required" }, { status: 400 });
	}

	const db = getDb(env);
	const userId = await getGroupBookOwner(db, user, mailboxId);
	if (!userId) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const group = await getOwnedGroup(db, userId, id);
	if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });

	const contact = contactId
		? (
			await db
				.select({ id: contacts.id })
				.from(contacts)
				.where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
				.limit(1)
		)[0]
		: await getContactByEmail(db, userId, normalizeEmailAddress(emailParam!));
	if (!contact) return NextResponse.json({ error: "Member not found" }, { status: 404 });

	const [member] = await db
		.select({ id: contactGroupMembers.id })
		.from(contactGroupMembers)
		.where(and(eq(contactGroupMembers.groupId, group.id), eq(contactGroupMembers.contactId, contact.id)))
		.limit(1);
	if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

	await db.delete(contactGroupMembers).where(eq(contactGroupMembers.id, member.id));
	return NextResponse.json({ members: await listGroupMembers(db, id) });
}
