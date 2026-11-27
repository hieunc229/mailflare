import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { externalAccounts } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getEnv } from "@/lib/cloudflare";
import { encryptSecret } from "@/lib/external-accounts/crypto";
import { updateExternalAccountSchema } from "@/lib/validators";
import type { MailboxAccountRouteParams } from "./types";
import {
	credentialWriteErrorResponse,
	encryptionErrorResponse,
	externalAccountColumns,
	externalAccountView,
	requireManagedMailbox,
	writeCredential,
} from "../utils";

export async function PATCH(request: Request, { params }: MailboxAccountRouteParams) {
	const { id, accountId } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = updateExternalAccountSchema.safeParse(await request.json());
	if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

	const db = getDb(env);
	const access = await requireManagedMailbox(db, user, id);
	if (access.error) return access.error;

	const [existing] = await db
		.select({ id: externalAccounts.id })
		.from(externalAccounts)
		.where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.mailboxId, id)))
		.limit(1);
	if (!existing) return NextResponse.json({ error: "Account not found" }, { status: 404 });

	const { password, ...fields } = parsed.data;
	const values: Partial<typeof externalAccounts.$inferInsert> = { ...fields, updatedAt: new Date() };
	if (password !== undefined) {
		// Re-encrypted only when the body carries a new password; absent means the stored one stays.
		try {
			values.passwordEncrypted = await encryptSecret(env, password);
		} catch (error) {
			const response = encryptionErrorResponse(error);
			if (response) return response;
			throw error;
		}
	}

	try {
		// The update binds the sealed credential when the body carries a password, so a driver rejection must not
		// escape with it.
		await writeCredential(() =>
			db
				.update(externalAccounts)
				.set(values)
				.where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.mailboxId, id))),
		);
	} catch (error) {
		const response = credentialWriteErrorResponse(error);
		if (response) return response;
		throw error;
	}

	const [updated] = await db.select(externalAccountColumns).from(externalAccounts).where(eq(externalAccounts.id, accountId)).limit(1);
	if (!updated) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	return NextResponse.json({ account: externalAccountView(updated) });
}

export async function DELETE(request: Request, { params }: MailboxAccountRouteParams) {
	const { id, accountId } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });

	const db = getDb(env);
	const access = await requireManagedMailbox(db, user, id);
	if (access.error) return access.error;

	// A credential has no soft-delete: the row goes, so nothing keeps a password around that the user removed.
	const [existing] = await db
		.select({ id: externalAccounts.id })
		.from(externalAccounts)
		.where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.mailboxId, id)))
		.limit(1);
	if (!existing) return NextResponse.json({ error: "Account not found" }, { status: 404 });
	await db.delete(externalAccounts).where(and(eq(externalAccounts.id, accountId), eq(externalAccounts.mailboxId, id)));
	return NextResponse.json({ ok: true });
}
