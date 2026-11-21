import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { getImportMessageUserId } from "@/lib/import/destination";
import { createFileImportJob } from "@/lib/import/jobs";
import { importMessagesToMailbox } from "@/lib/import/service";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { parseImportForm } from "./utils";

export async function POST(request: Request) {
	const env = getEnv();
	const user = await requireUser(env, request);
	let input: Awaited<ReturnType<typeof parseImportForm>>;
	try {
		input = await parseImportForm(request);
	} catch (error) {
		const status = error instanceof RequestBodyTooLargeError ? 413 : 400;
		return NextResponse.json({ error: "Invalid import upload" }, { status });
	}

	if (!input.mailboxId || input.messages.length === 0) {
		return NextResponse.json({ error: "Select a mailbox and at least one .eml or .mbox file" }, { status: 400 });
	}

	const db = getDb(env);
	const access = await getMailboxAccessLevel(db, user, input.mailboxId);
	if (!access?.canManage) {
		return NextResponse.json({ error: "Mailbox not found" }, { status: 404 });
	}
	if (input.destination.type === "folder") {
		const [folder] = await db
			.select({ id: folders.id })
			.from(folders)
			.where(and(eq(folders.id, input.destination.folderId), eq(folders.mailboxId, access.mailbox.id)))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
	}

	if (!input.background) {
		const result = await importMessagesToMailbox(env, {
			userId: getImportMessageUserId(input.destination, user.id, access.mailbox.userId),
			mailboxId: access.mailbox.id,
			destination: input.destination,
			messages: input.messages,
		});
		return NextResponse.json({ ...result, ...(input.truncated ? { truncated: input.truncated } : {}) });
	}

	const job = await createFileImportJob(env, {
		userId: user.id,
		mailboxId: access.mailbox.id,
		label: summarizeFilenames(input.filenames),
		destination: input.destinationValue,
		messages: input.messages,
	});
	return NextResponse.json({ job, ...(input.truncated ? { truncated: input.truncated } : {}) }, { status: 202 });
}

function summarizeFilenames(names: string[]): string {
	const label = names.slice(0, 2).join(", ");
	return (names.length > 2 ? `${label} +${names.length - 2}` : label).slice(0, 120) || "Uploaded files";
}
