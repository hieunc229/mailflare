import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { folders } from "@/db/schema";
import { requireUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { createFileImportJob } from "@/lib/import/jobs";
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

	const job = await createFileImportJob(env, {
		userId: user.id,
		mailboxId: access.mailbox.id,
		label: summarizeFilenames(input.filenames),
		destination: input.destinationValue,
		messages: input.messages,
	});
	return NextResponse.json({ job }, { status: 202 });
}

function summarizeFilenames(names: string[]): string {
	const label = names.slice(0, 2).join(", ");
	return (names.length > 2 ? `${label} +${names.length - 2}` : label).slice(0, 120) || "Uploaded files";
}
