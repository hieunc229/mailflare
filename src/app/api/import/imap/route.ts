import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { assertSafeImapHost } from "@/lib/import/imap-utils";
import { createImapImportJob } from "@/lib/import/jobs";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { ImapImportRequest } from "./types";
import { parseImapImportRequest } from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input: ReturnType<typeof parseImapImportRequest>;
	try {
		const body = await readJsonBody<ImapImportRequest>(request, 64 * 1024);
		input = parseImapImportRequest(body);
		assertSafeImapHost(input.spec.host);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid IMAP import request" }, { status });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, input.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	const folderIds = Array.from(
		new Set(input.destinations.flatMap((destination) => (destination.type === "folder" ? [destination.folderId] : []))),
	);
	if (folderIds.length > 0) {
		const found = await db
			.select({ id: folders.id })
			.from(folders)
			.where(and(inArray(folders.id, folderIds), eq(folders.mailboxId, access.mailbox.id)));
		if (found.length !== folderIds.length) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
	}

	const job = await createImapImportJob(env, {
		userId: user.id,
		mailboxId: access.mailbox.id,
		password: input.password,
		spec: input.spec,
	});
	return NextResponse.json({ job }, { status: 202 });
}
