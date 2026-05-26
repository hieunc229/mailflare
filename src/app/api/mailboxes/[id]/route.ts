import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { updateMailboxSchema } from "@/lib/validators";
import type { MailboxRouteParams } from "./types";
import { getMailboxUpdateValues, selectMailboxForUser } from "./utils";

export async function GET(_request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env);
	const db = getDb(env);
	const [mailbox] = await selectMailboxForUser(db, user.id, id);

	if (!mailbox) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	return NextResponse.json({
		mailbox: {
			...mailbox,
			isPrimary: `${mailbox.localPart}@${mailbox.hostname}` === user.email,
		},
	});
}

export async function PATCH(request: Request, { params }: MailboxRouteParams) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env);
	const parsed = updateMailboxSchema.safeParse(await request.json());

	if (!parsed.success) {
		return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
	}

	const db = getDb(env);
	const [existing] = await selectMailboxForUser(db, user.id, id);

	if (!existing) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}

	const updateValues = getMailboxUpdateValues(parsed.data);
	if (Object.keys(updateValues).length > 0) {
		await db
			.update(mailboxes)
			.set(updateValues)
			.where(eq(mailboxes.id, id));
	}

	const [mailbox] = await selectMailboxForUser(db, user.id, id);

	return NextResponse.json({
		mailbox: {
			...mailbox,
			isPrimary: `${mailbox!.localPart}@${mailbox!.hostname}` === user.email,
		},
	});
}
