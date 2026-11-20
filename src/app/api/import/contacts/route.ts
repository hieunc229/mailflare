import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireSessionUser } from "@/lib/api/auth";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { ContactDetailsUnavailableError, importContacts } from "@/lib/contacts/import-store";
import { readContactImportBody } from "@/lib/contacts/import-store-utils";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Imports the contacts of one Google Takeout .vcf or Google CSV file, a few cards at a time, into the address book of
 * the chosen mailbox. Only the address book's owner may import: a delegate of a shared mailbox, even with full access,
 * must not write into (or later read the details of) the owner's personal book. Safe to repeat: see importContacts.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	let body: unknown;
	try {
		body = await readJsonBody<unknown>(request, MAX_BODY_BYTES);
	} catch (caught) {
		return caught instanceof RequestBodyTooLargeError
			? NextResponse.json({ error: "Request body is too large" }, { status: 413 })
			: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const input = readContactImportBody(body);
	if (!input.value) return NextResponse.json({ error: input.error }, { status: 400 });
	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, input.value.mailboxId);
	if (!access?.isOwner) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	try {
		return NextResponse.json(await importContacts(db, { userId: access.mailbox.userId, body: input.value }));
	} catch (caught) {
		if (caught instanceof RequestBodyTooLargeError) return NextResponse.json({ error: caught.message }, { status: 413 });
		if (caught instanceof ContactDetailsUnavailableError) return NextResponse.json({ error: caught.message }, { status: 409 });
		throw caught;
	}
}
