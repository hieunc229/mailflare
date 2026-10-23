import { and, eq } from "drizzle-orm";
import { messages } from "@/db/schema";
import { sendEmail } from "@/lib/email/send";
import { loadMessageAttachmentContents } from "@/lib/email/attachments";
import { deleteMessageWithObjects } from "@/lib/email/message-cleanup";
import { decodeIdentityId, identityId } from "./ids";
import { listJmapMailboxes, listSendableAddresses } from "./access";
import { getEmailState } from "./state";
import { JmapError } from "./errors";
import type { JmapContext, JmapMethodHandler } from "./types";

/** One Identity per address the account may send from. */
export async function buildIdentities(ctx: JmapContext) {
	const list: Array<Record<string, unknown>> = [];
	const sendable = (await listJmapMailboxes(ctx)).filter((mailbox) => mailbox.permission !== "read_only");
	const addresses = await Promise.all(sendable.map((mailbox) => listSendableAddresses(ctx, mailbox)));
	for (const [index, mailbox] of sendable.entries()) {
		for (const address of addresses[index]) {
			list.push({
				id: identityId(mailbox.id, address),
				name: mailbox.displayName ?? "",
				email: address,
				replyTo: null,
				bcc: null,
				textSignature: "",
				htmlSignature: "",
				mayDelete: false,
			});
		}
	}
	return list;
}

export const identityGet: JmapMethodHandler = async (ctx, args) => {
	const all = await buildIdentities(ctx);
	const ids = args.ids as string[] | null | undefined;
	const list = ids ? all.filter((item) => ids.includes(item.id as string)) : all;
	const found = new Set(list.map((item) => item.id as string));
	return { accountId: ctx.accountId, state: "identities", list, notFound: ids ? ids.filter((id) => !found.has(id)) : [] };
};

export const identityChanges: JmapMethodHandler = async () => ({ type: "cannotCalculateChanges" });
export const identitySet: JmapMethodHandler = async (ctx, args) => ({
	accountId: ctx.accountId,
	oldState: "identities",
	newState: "identities",
	created: {},
	updated: {},
	destroyed: [],
	notCreated: Object.fromEntries(Object.keys((args.create ?? {}) as object).map((id) => [id, { type: "forbidden" }])),
	notUpdated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((id) => [id, { type: "forbidden" }])),
	notDestroyed: Object.fromEntries(((args.destroy ?? []) as string[]).map((id) => [id, { type: "forbidden" }])),
});

/**
 * EmailSubmission/set: send a draft. Mailflare's send writes a fresh Sent row,
 * so the draft is removed afterwards and the submission id is the sent
 * message's id; onSuccessDestroyEmail / onSuccessUpdateEmail are honoured
 * by reporting the draft as destroyed.
 */
export const emailSubmissionSet: JmapMethodHandler = async (ctx, args) => {
	const oldState = await getEmailState(ctx);
	const created: Record<string, unknown> = {};
	const notCreated: Record<string, unknown> = {};
	const destroyedEmails: string[] = [];

	for (const [creationId, value] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
		const emailId = ctx.createdIds[String(value.emailId).replace(/^#/, "")] ?? String(value.emailId ?? "");
		const identity = typeof value.identityId === "string" ? decodeIdentityId(value.identityId) : null;
		const accessible = await listJmapMailboxes(ctx);
		if (!identity || !accessible.some((mailbox) => mailbox.id === identity.mailboxId && mailbox.permission !== "read_only")) {
			notCreated[creationId] = { type: "invalidProperties", properties: ["identityId"] };
			continue;
		}
		const [draft] = await ctx.db.select().from(messages).where(and(eq(messages.id, emailId), eq(messages.status, "draft"))).limit(1);
		if (!draft || draft.userId !== ctx.auth.userId || draft.mailboxId !== identity.mailboxId) {
			notCreated[creationId] = { type: "invalidProperties", properties: ["emailId"], description: "Not a draft of this account" };
			continue;
		}
		try {
			const attachments = await loadMessageAttachmentContents(ctx.env, draft.id);
			const result = await sendEmail(ctx.env, {
				userId: ctx.auth.userId,
				from: identity.address,
				to: draft.toAddr,
				cc: draft.ccAddr ?? undefined,
				bcc: draft.bccAddr ?? undefined,
				subject: draft.subject ?? "(no subject)",
				text: draft.textBody ?? undefined,
				html: draft.htmlBody ?? undefined,
				inReplyTo: draft.inReplyTo,
				references: draft.references,
				threadId: draft.threadId,
				mailboxId: identity.mailboxId,
				attachments,
				publicOrigin: ctx.origin,
			});
			try {
				await deleteMessageWithObjects(ctx.env, ctx.db, draft.id, draft.rawR2Key);
			} catch (error) {
				// Sending is irreversible, so cleanup failure must not invite a retry
				// that could deliver the same message twice.
				console.error(`Failed to clean up submitted draft ${draft.id}`, error);
			}
			destroyedEmails.push(draft.id);
			ctx.createdIds[creationId] = result.messageId;
			created[creationId] = {
				id: result.messageId,
				identityId: value.identityId,
				emailId: result.messageId,
				threadId: draft.threadId ?? result.messageId,
				envelope: null,
				sendAt: new Date().toISOString(),
				undoStatus: "final",
				deliveryStatus: null,
				dsnBlobIds: [],
				mdnBlobIds: [],
			};
		} catch (error) {
			notCreated[creationId] = { type: "forbidden", description: error instanceof Error ? error.message : "Send failed" };
		}
	}

	return {
		accountId: ctx.accountId,
		oldState,
		newState: await getEmailState(ctx),
		created,
		updated: {},
		destroyed: [],
		notCreated,
		notUpdated: Object.fromEntries(Object.keys((args.update ?? {}) as object).map((id) => [id, { type: "forbidden" }])),
		notDestroyed: Object.fromEntries(((args.destroy ?? []) as string[]).map((id) => [id, { type: "forbidden" }])),
		// Surfaced so the processor can append the implicit Email/set response.
		__destroyedEmails: destroyedEmails,
	};
};

export const emailSubmissionGet: JmapMethodHandler = async (ctx, args) => ({
	accountId: ctx.accountId,
	state: await getEmailState(ctx),
	list: [],
	notFound: ((args.ids ?? []) as string[]) ?? [],
});
export const emailSubmissionQuery: JmapMethodHandler = async (ctx) => ({ accountId: ctx.accountId, queryState: await getEmailState(ctx), canCalculateChanges: false, position: 0, ids: [], total: 0 });
export const emailSubmissionChanges: JmapMethodHandler = async () => ({ type: "cannotCalculateChanges" });

export { JmapError };
