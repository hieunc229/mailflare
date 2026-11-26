import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { encryptSecret } from "@/lib/external-accounts/crypto";
import { newId } from "@/lib/ids";
import { externalAccountSchema } from "@/lib/validators";
import type { MailboxAccountsRouteParams } from "./types";
import {
	credentialWriteErrorResponse,
	encryptionErrorResponse,
	externalAccountColumns,
	externalAccountView,
	requireManagedMailbox,
	writeCredential,
} from "./utils";

/**
 * External IMAP/POP3 accounts a mailbox pulls from. F36 stores credentials and creates the seam; the pollers
 * (F37/F38) and the settings UI (F39) come later. No client or scheduling code lives here.
 */
export async function GET(request: Request, { params }: MailboxAccountsRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const db = getDb(env);
	const access = await requireManagedMailbox(db, user, id);
	if (access.error) return access.error;

	const rows = await db
		.select(externalAccountColumns)
		.from(externalAccounts)
		.where(eq(externalAccounts.mailboxId, id))
		.orderBy(asc(externalAccounts.createdAt));
	return NextResponse.json({ accounts: rows.map(externalAccountView) });
}

export async function POST(request: Request, { params }: MailboxAccountsRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = externalAccountSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const db = getDb(env);
	const access = await requireManagedMailbox(db, user, id);
	if (access.error) return access.error;

	let passwordEncrypted: string;
	try {
		passwordEncrypted = await encryptSecret(env, parsed.data.password);
	} catch (error) {
		// A missing or placeholder MAILFLARE_ENCRYPTION_KEY: refuse rather than ever store the password as-is.
		const response = encryptionErrorResponse(error);
		if (response) return response;
		throw error;
	}

	const row = {
		id: newId("ext"),
		// The account belongs to the mailbox it fetches into, and to that mailbox's owner.
		mailboxId: id,
		userId: access.mailbox.userId,
		protocol: parsed.data.protocol,
		host: parsed.data.host,
		port: parsed.data.port,
		tlsMode: parsed.data.tlsMode,
		username: parsed.data.username,
		passwordEncrypted,
		enabled: parsed.data.enabled,
	};
	try {
		// The statement binds the sealed credential, so a driver rejection must not escape with it.
		await writeCredential(() => db.insert(externalAccounts).values(row));
	} catch (error) {
		const response = credentialWriteErrorResponse(error);
		if (response) return response;
		throw error;
	}

	const [created] = await db.select(externalAccountColumns).from(externalAccounts).where(eq(externalAccounts.id, row.id)).limit(1);
	if (!created) return NextResponse.json({ error: "The account was not saved" }, { status: 500 });
	return NextResponse.json({ account: externalAccountView(created) }, { status: 201 });
}
