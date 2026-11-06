import { eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, spamFeedback, spamReputation, spamTokenStats } from "@/db/schema";
import { excluded, greatest } from "@/db/sql";
import { getMailboxAccessLevel } from "@/lib/mailboxes/access";
import type { MailboxAccessLevel } from "@/lib/mailboxes/types";
import type { SessionUser } from "@/lib/auth/types";
import { createAuditLog } from "@/lib/mailboxes/audit";
import { buildFingerprint, prepareSpamContent, tokenizeMessage } from "./tokenizer";
import { getReputationKeys } from "./analyzers/reputation";
import type { ReputationKey, SpamClassification } from "./types";
import { TOKENIZER_VERSION } from "./weights";

export async function applySpamFeedback(env: CloudflareEnv, user: SessionUser, messageId: string, classification: SpamClassification, access?: MailboxAccessLevel | null): Promise<boolean> {
	const db = getDb(env);
	const [message] = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
	if (!message?.mailboxId || message.direction !== "inbound") return false;
	const resolvedAccess = access === undefined ? await getMailboxAccessLevel(db, user, message.mailboxId) : access;
	if (!resolvedAccess?.canManage) return false;
	const [previous] = await db.select().from(spamFeedback).where(eq(spamFeedback.messageId, messageId)).limit(1);
	const status = classification === "spam" ? "spam" : "received";
	if (previous?.classification === classification) {
		await db.update(messages).set({ status, folderId: null }).where(eq(messages.id, messageId));
		return true;
	}

	const parsed = {
		subject: message.subject, text: message.textBody, html: message.htmlBody,
		messageId: message.providerMessageId, fromAddr: message.fromAddr, toAddr: message.toAddr,
		ccAddr: message.ccAddr, bccAddr: message.bccAddr, replyTo: message.replyTo, inReplyTo: message.inReplyTo,
		references: message.references?.split(/\s+/).filter(Boolean) ?? [], date: message.createdAt,
		attachments: [],
	};
	const prepared = prepareSpamContent(parsed);
	const tokens = previous ? JSON.parse(previous.trainingTokens) as string[] : tokenizeMessage(parsed, prepared);
	const keys = previous ? JSON.parse(previous.reputationKeys) as ReputationKey[] : getReputationKeys(parsed, buildFingerprint(parsed, prepared));
	const now = new Date();
	const statements: Array<PromiseLike<unknown>> = [];
	const addCounts = (target: SpamClassification, amount: 1 | -1) => {
		const spamCount = target === "spam" ? amount : 0;
		const hamCount = target === "ham" ? amount : 0;
		for (const token of tokens) {
			statements.push(db.insert(spamTokenStats).values({ mailboxId: message.mailboxId!, token, spamCount, hamCount, updatedAt: now }).onConflictDoUpdate({
				target: [spamTokenStats.mailboxId, spamTokenStats.token],
				set: {
					spamCount: greatest(0, sql`${spamTokenStats.spamCount} + ${excluded(spamTokenStats.spamCount)}`),
					hamCount: greatest(0, sql`${spamTokenStats.hamCount} + ${excluded(spamTokenStats.hamCount)}`),
					updatedAt: now,
				},
			}));
		}
		for (const item of keys) {
			statements.push(db.insert(spamReputation).values({
				mailboxId: message.mailboxId!, type: item.type, key: item.key, messagesSeen: amount > 0 ? 1 : 0, spamCount, hamCount, firstSeenAt: now, lastSeenAt: now,
			}).onConflictDoUpdate({
				target: [spamReputation.mailboxId, spamReputation.type, spamReputation.key],
				set: {
					messagesSeen: greatest(sql`${spamReputation.messagesSeen}`, sql`${excluded(spamReputation.messagesSeen)}`),
					spamCount: greatest(0, sql`${spamReputation.spamCount} + ${excluded(spamReputation.spamCount)}`),
					hamCount: greatest(0, sql`${spamReputation.hamCount} + ${excluded(spamReputation.hamCount)}`),
					lastSeenAt: now,
				},
			}));
		}
	};
	if (previous) addCounts(previous.classification, -1);
	addCounts(classification, 1);
	statements.push(db.insert(spamFeedback).values({
		messageId, mailboxId: message.mailboxId, actorUserId: user.id, classification, trainingTokens: JSON.stringify(tokens),
		reputationKeys: JSON.stringify(keys), tokenizerVersion: TOKENIZER_VERSION, createdAt: now, updatedAt: now,
	}).onConflictDoUpdate({
		target: spamFeedback.messageId,
		set: { actorUserId: user.id, classification, updatedAt: now },
	}));
	statements.push(db.update(messages).set({ status, folderId: null }).where(eq(messages.id, messageId)));
	await db.batch(statements as never);
	await createAuditLog(env, {
		actorUserId: user.id,
		mailboxId: message.mailboxId,
		messageId,
		action: "email.spam_feedback",
		metadata: { classification },
	});
	return true;
}
