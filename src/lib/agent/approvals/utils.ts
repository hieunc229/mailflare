import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { agentDraftMetadata, agentSendApprovals, contacts, messageAttachments, messages } from "@/db/schema";
import { getEmailAddress, splitEmailAddressList } from "@/lib/email/address";
import { getAuthorizedSenderAddress } from "@/lib/email/sender";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { sendEmail } from "@/lib/email/send";
import { newId } from "@/lib/ids";
import type { SessionUser } from "@/lib/auth/types";
import type { AgentSendSnapshot } from "./types";

async function sha256(value: ArrayBuffer | string) {
	const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function currentDraft(env: CloudflareEnv, user: SessionUser, draftId: string) {
	const db = getDb(env);
	const [draft] = await db.select().from(messages).where(and(eq(messages.id, draftId), eq(messages.userId, user.id), eq(messages.status, "draft"))).limit(1);
	if (!draft?.mailboxId) throw new Error("Draft not found");
	const [metadata] = await db.select().from(agentDraftMetadata).where(eq(agentDraftMetadata.draftId, draftId)).limit(1);
	if (!metadata) throw new Error("Agent draft not found");
	await getAuthorizedSenderAddress(env, { userId: user.id, mailboxId: draft.mailboxId, from: draft.fromAddr });
	return { draft, metadata };
}

async function snapshot(env: CloudflareEnv, draft: typeof messages.$inferSelect, scheduledAt: Date | null): Promise<{ payload: AgentSendSnapshot; hash: string }> {
	const db = getDb(env);
	const rows = await db.select().from(messageAttachments).where(eq(messageAttachments.messageId, draft.id));
	const attachments: AgentSendSnapshot["attachments"] = [];
	for (const row of rows) {
		const object = await env.BUCKET.get(row.r2Key);
		if (!object) throw new Error("Draft attachment missing");
		attachments.push({ id: row.id, filename: row.filename, size: row.size, digest: await sha256(await object.arrayBuffer()) });
	}
	attachments.sort((a, b) => a.id.localeCompare(b.id));
	const payload: AgentSendSnapshot = {
		from: draft.fromAddr, to: draft.toAddr, cc: draft.ccAddr, bcc: draft.bccAddr,
		subject: draft.subject ?? "", text: draft.textBody, html: draft.htmlBody,
		inReplyTo: draft.inReplyTo, references: draft.references, threadId: draft.threadId,
		mailboxId: draft.mailboxId!, scheduledAt: scheduledAt?.toISOString() ?? null, attachments,
	};
	if (!payload.to.trim() || !payload.subject.trim() || !(payload.text?.trim() || payload.html?.trim())) throw new Error("Draft is incomplete");
	return { payload, hash: await sha256(JSON.stringify(payload)) };
}

export async function requestAgentSend(env: CloudflareEnv, user: SessionUser, draftId: string, expectedRevision: number, requestKeyId?: string) {
	const { draft, metadata } = await currentDraft(env, user, draftId);
	if (metadata.revision !== expectedRevision) throw new Error("Draft changed; reopen it for review");
	if (metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now()) throw new Error("Scheduled time has passed; update the draft before review");
	const [existing] = await getDb(env).select({ id: agentSendApprovals.id }).from(agentSendApprovals).where(and(eq(agentSendApprovals.draftId, draftId), inArray(agentSendApprovals.status, ["claimed", "sent", "unknown"]))).limit(1);
	if (existing) throw new Error("This draft has a delivery already in progress or awaiting reconciliation");
	const { payload, hash } = await snapshot(env, draft, metadata.scheduledAt);
	const id = newId("approval");
	const expiresAt = new Date(Date.now() + 15 * 60_000);
	await getDb(env).insert(agentSendApprovals).values({ id, draftId, mailboxId: draft.mailboxId!, userId: user.id, requestKeyId: requestKeyId ?? null, revision: expectedRevision, payloadHash: hash, expiresAt });
	return { approvalId: id, status: "pending_approval", expiresAt, snapshot: payload, reviewUrl: `/agent/review/${id}` };
}

/** Recipients the user has never written to or saved: where an injected instruction would send private text. */
async function unfamiliarRecipients(env: CloudflareEnv, userId: string, snapshot: AgentSendSnapshot): Promise<string[]> {
	const addresses = [...new Set([snapshot.to, snapshot.cc, snapshot.bcc].flatMap((list) => splitEmailAddressList(list)).map((entry) => (getEmailAddress(entry) || entry).toLowerCase()).filter(Boolean))];
	if (!addresses.length) return [];
	const known = await getDb(env).select({ email: contacts.email }).from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.email, addresses), inArray(contacts.source, ["outbound", "manual"])));
	const familiar = new Set(known.map((row) => row.email));
	return addresses.filter((address) => !familiar.has(address));
}

export async function getAgentSendRequest(env: CloudflareEnv, user: SessionUser, approvalId: string) {
	const [approval] = await getDb(env).select().from(agentSendApprovals).where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.userId, user.id))).limit(1);
	if (!approval) throw new Error("Approval not found");
	let current: AgentSendSnapshot | null = null;
	let stale = false;
	if (approval.status === "pending") {
		try {
			const { draft, metadata } = await currentDraft(env, user, approval.draftId);
			const read = await snapshot(env, draft, metadata.scheduledAt);
			stale = metadata.revision !== approval.revision || read.hash !== approval.payloadHash || !!(metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now());
			if (!stale) current = read.payload;
		} catch { stale = true; }
	}
	const unfamiliar = current ? await unfamiliarRecipients(env, user.id, current) : [];
	return { approvalId, status: approval.status, draftId: approval.draftId, messageId: approval.messageId, expiresAt: approval.expiresAt, snapshot: current, stale, unfamiliarRecipients: unfamiliar };
}

export async function confirmAgentSend(env: CloudflareEnv, user: SessionUser, approvalId: string, publicOrigin?: string) {
	const db = getDb(env);
	const [approval] = await db.select().from(agentSendApprovals).where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.userId, user.id))).limit(1);
	if (!approval) throw new Error("Approval not found");
	if (approval.status !== "pending") return { status: approval.status, messageId: approval.messageId };
	if (approval.expiresAt < new Date()) {
		await db.update(agentSendApprovals).set({ status: "expired" }).where(eq(agentSendApprovals.id, approvalId));
		throw new Error("Approval expired");
	}
	const { draft, metadata } = await currentDraft(env, user, approval.draftId);
	const current = await snapshot(env, draft, metadata.scheduledAt);
	if (metadata.revision !== approval.revision || current.hash !== approval.payloadHash) throw new Error("Draft changed; review it again");
	if (metadata.scheduledAt && metadata.scheduledAt.getTime() <= Date.now()) throw new Error("Scheduled time has passed; update the draft before confirming");
	const claimed = await db.update(agentSendApprovals).set({ status: "claimed", claimedAt: new Date() }).where(and(eq(agentSendApprovals.id, approvalId), eq(agentSendApprovals.status, "pending"))).returning({ id: agentSendApprovals.id });
	if (!claimed.length) return getAgentSendRequest(env, user, approvalId);
	try {
		const result = await sendEmail(env, {
			userId: user.id, mailboxId: draft.mailboxId!, from: draft.fromAddr, to: draft.toAddr,
			cc: draft.ccAddr || undefined, bcc: draft.bccAddr || undefined,
			subject: draft.subject || "", text: draft.textBody || undefined, html: draft.htmlBody || undefined,
		inReplyTo: draft.inReplyTo, references: draft.references, threadId: draft.threadId,
			attachments: await loadMessageAttachmentContents(env, draft.id),
			scheduledAt: metadata.scheduledAt ?? undefined,
			publicOrigin,
		});
		await db.update(agentSendApprovals).set({ status: "sent", messageId: result.messageId }).where(eq(agentSendApprovals.id, approvalId));
		await db.update(messages).set({ status: "trash" }).where(and(eq(messages.id, draft.id), eq(messages.status, "draft")));
		return { status: "sent", messageId: result.messageId, scheduled: !!result.scheduled };
	} catch (error) {
		await db.update(agentSendApprovals).set({ status: "unknown" }).where(eq(agentSendApprovals.id, approvalId));
		throw new Error(`Delivery outcome needs review: ${error instanceof Error ? error.message : "provider error"}`);
	}
}
