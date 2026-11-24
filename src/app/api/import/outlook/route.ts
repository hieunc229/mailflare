import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireSessionUser } from "@/lib/api/auth";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readJsonBody } from "@/lib/http/request";
import { createImapImportJob } from "@/lib/import/jobs";
import { outlookGrantForUser, refreshOutlookAccessToken, writeOutlookGrant } from "@/lib/import/outlook";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { parseOutlookImportRequest, type OutlookImportBody } from "./utils";

/** Queues an Outlook import. The refresh token rides the queue message and is not stored on the job. */
export async function POST(request: Request) {
	const env = getEnv();
	const { user, error } = await requireSessionUser(env, request);
	if (error) return error;
	const grant = outlookGrantForUser(request, user.id);
	if (!grant) return NextResponse.json({ error: "Microsoft sign-in expired; connect Outlook again" }, { status: 401 });

	let parsed: ReturnType<typeof parseOutlookImportRequest>;
	try {
		parsed = parseOutlookImportRequest(await readJsonBody<OutlookImportBody>(request, 64 * 1024));
	} catch (cause) {
		const status = cause instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: cause instanceof Error ? cause.message : "Invalid Outlook import request" }, { status });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, parsed.mailboxId);
	if (!access?.canManage) return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	const folderIds = Array.from(new Set(parsed.destinations.flatMap((destination) => (destination.type === "folder" ? [destination.folderId] : []))));
	if (folderIds.length > 0) {
		let found = 0;
		for (let i = 0; i < folderIds.length; i += 90) {
			const rows = await db
				.select({ id: folders.id })
				.from(folders)
				.where(and(inArray(folders.id, folderIds.slice(i, i + 90)), eq(folders.mailboxId, access.mailbox.id)));
			found += rows.length;
		}
		if (found !== folderIds.length) return NextResponse.json({ error: "Folder not found" }, { status: 404 });
	}

	let outlook = grant;
	try {
		const refreshed = await refreshOutlookAccessToken(grant);
		outlook = { ...grant, refreshToken: refreshed.refreshToken };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : "Microsoft sign-in expired; connect Outlook again";
		return NextResponse.json({ error: message }, { status: /sign-in expired/i.test(message) ? 401 : 502 });
	}

	const job = await createImapImportJob(env, {
		userId: user.id,
		mailboxId: access.mailbox.id,
		outlook,
		spec: { ...parsed.spec, username: grant.username },
	});
	const response = NextResponse.json({ job }, { status: 202 });
	if (outlook.refreshToken !== grant.refreshToken) writeOutlookGrant(response, outlook);
	return response;
}
