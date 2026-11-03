import { eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import type { AppDatabase } from "@/db";
import { getDb } from "@/db";
import { folders, messages } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/cookies";
import { getEnv } from "@/lib/cloudflare";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import { createAuditLogs } from "@/lib/mailboxes/audit";
import { permanentlyDeleteMessages } from "@/lib/email/permanent-delete";
import { applySpamFeedback } from "@/lib/spam/feedback";
import type { BulkMessagePayload } from "./types";
import {
	getReadValueForBulkAction,
	getStatusForBulkAction,
	isAllowedBulkMessageAction,
	isPermanentlyDeletableStatus,
} from "./utils";

const MAX_BULK_MESSAGES = 5000;
const MESSAGE_ID_CHUNK = 90;
const MESSAGE_QUERY_CONCURRENCY = 5;

async function loadMessagesByIds(db: AppDatabase, ids: string[]) {
	const chunks: string[][] = [];
	for (let index = 0; index < ids.length; index += MESSAGE_ID_CHUNK) {
		chunks.push(ids.slice(index, index + MESSAGE_ID_CHUNK));
	}
	const rows: Awaited<ReturnType<typeof selectMessageChunk>> = [];
	for (let index = 0; index < chunks.length; index += MESSAGE_QUERY_CONCURRENCY) {
		const batch = await Promise.all(chunks.slice(index, index + MESSAGE_QUERY_CONCURRENCY).map((chunk) => selectMessageChunk(db, chunk)));
		rows.push(...batch.flat());
	}
	return rows;
}

function selectMessageChunk(db: AppDatabase, chunk: string[]) {
	return db.select({
		id: messages.id,
		mailboxId: messages.mailboxId,
		rawR2Key: messages.rawR2Key,
		status: messages.status,
	})
		.from(messages)
		.where(inArray(messages.id, chunk));
}

export async function POST(request: Request) {
	const env = getEnv();
	const user = await getCurrentUser(env, request);
	if (!user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const payload = (await request.json()) as BulkMessagePayload;
	const messageIds = [...new Set(payload.messageIds?.filter(Boolean) ?? [])];
	if (messageIds.length === 0 || !isAllowedBulkMessageAction(payload.action)) {
		return NextResponse.json({ error: "Invalid bulk message action" }, { status: 400 });
	}
	if (messageIds.length > MAX_BULK_MESSAGES) {
		return NextResponse.json({ error: `Select up to ${MAX_BULK_MESSAGES} messages at a time` }, { status: 400 });
	}

	const status = getStatusForBulkAction(payload.action);
	const read = getReadValueForBulkAction(payload.action);
	const db = getDb(env);
	let folderId: string | null | undefined;

	if (payload.action === "folder") {
		if (!payload.folderId) {
			return NextResponse.json({ error: "Folder is required" }, { status: 400 });
		}
		const [folder] = await db
			.select({ id: folders.id, mailboxId: folders.mailboxId })
			.from(folders)
			.where(eq(folders.id, payload.folderId))
			.limit(1);
		if (!folder) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		const folderAccess = await getMailboxAccessLevel(db, user, folder.mailboxId);
		if (!folderAccess?.canManage) {
			return NextResponse.json({ error: "Folder not found" }, { status: 404 });
		}
		folderId = folder.id;
	} else if (payload.action === "spam" || payload.action === "trash" || payload.action === "inbox" || payload.action === "archive") {
		folderId = null;
	}

	const values = {
		...(status ? { status } : {}),
		...(read !== null ? { read } : {}),
		...(folderId !== undefined ? { folderId } : {}),
		...(payload.action === "inbox" ? { snoozedUntil: null } : {}),
	};

	if (payload.action !== "delete" && Object.keys(values).length === 0) {
		return NextResponse.json({ error: "No changes requested" }, { status: 400 });
	}

	const selectedMessages = await loadMessagesByIds(db, messageIds);
	const mailboxIds = [...new Set(selectedMessages.flatMap((message) => message.mailboxId ? [message.mailboxId] : []))];
	const accessByMailbox = new Map(await Promise.all(mailboxIds.map(async (mailboxId) => (
		[mailboxId, await getMailboxAccessLevel(db, user, mailboxId)] as const
	))));
	const allowedMessageIds: string[] = [];

	for (const message of selectedMessages) {
		if (!message.mailboxId) continue;
		const access = accessByMailbox.get(message.mailboxId);
		const canUpdate = payload.action === "read" || payload.action === "unread" ? access?.canRead : access?.canManage;
		if (!canUpdate) continue;
		allowedMessageIds.push(message.id);
	}

	if (allowedMessageIds.length === 0) {
		return NextResponse.json({ error: "No accessible messages" }, { status: 404 });
	}
	const allowedIds = new Set(allowedMessageIds);
	if (payload.action === "delete") {
		// Only mail already in Trash or Spam can be destroyed; anything else is skipped.
		const deletable = selectedMessages.filter(
			(message) => allowedIds.has(message.id) && isPermanentlyDeletableStatus(message.status),
		);
		const deleted = await permanentlyDeleteMessages(env, db, user.id, deletable, "bulk");
		return NextResponse.json({ ok: true, deleted, skipped: allowedMessageIds.length - deleted });
	}
	if (payload.action === "spam") {
		for (const message of selectedMessages) {
			if (!allowedIds.has(message.id) || !message.mailboxId) continue;
			await applySpamFeedback(env, user, message.id, "spam", accessByMailbox.get(message.mailboxId));
		}
		return NextResponse.json({ ok: true });
	}
	if (payload.action === "inbox") {
		const spamMessages = selectedMessages.filter((message) => message.status === "spam" && allowedIds.has(message.id));
		const spamMessageIds = new Set(spamMessages.map((message) => message.id));
		const normalMessageIds = allowedMessageIds.filter((messageId) => !spamMessageIds.has(messageId));
		for (const message of spamMessages) {
			if (!message.mailboxId) continue;
			await applySpamFeedback(env, user, message.id, "ham", accessByMailbox.get(message.mailboxId));
		}
		if (normalMessageIds.length) {
			for (let index = 0; index < normalMessageIds.length; index += MESSAGE_ID_CHUNK) {
				await db.update(messages).set(values).where(inArray(messages.id, normalMessageIds.slice(index, index + MESSAGE_ID_CHUNK)));
			}
		}
		return NextResponse.json({ ok: true });
	}

	for (let index = 0; index < allowedMessageIds.length; index += MESSAGE_ID_CHUNK) {
		await db.update(messages).set(values).where(inArray(messages.id, allowedMessageIds.slice(index, index + MESSAGE_ID_CHUNK)));
	}
	await createAuditLogs(env, allowedMessageIds.map((messageId) => ({
		actorUserId: user.id,
		messageId,
		action: payload.action === "read" || payload.action === "unread" ? "email.read" : "email.delete",
		metadata: { bulkAction: payload.action },
	})));

	return NextResponse.json({ ok: true });
}
