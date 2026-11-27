import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { assertSafeImapHost } from "@/lib/import/imap-utils";
import { isVercelRuntime } from "@/lib/runtime";
import { createImapImportJob } from "@/lib/import/jobs";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { ImapImportRequest } from "./types";
import { parseImapImportRequest } from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	// IMAP needs Workers sockets, and the password would otherwise sit in the external queue.
	if (isVercelRuntime(env)) return NextResponse.json({ error: "IMAP import is not supported on Vercel" }, { status: 400 });
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
		// D1 caps bound parameters at 100 per query, and an IMAP account can map to more folders than that.
		let found = 0;
		for (let i = 0; i < folderIds.length; i += 90) {
			const rows = await db
				.select({ id: folders.id })
				.from(folders)
				.where(and(inArray(folders.id, folderIds.slice(i, i + 90)), eq(folders.mailboxId, access.mailbox.id)));
			found += rows.length;
		}
		if (found !== folderIds.length) {
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
