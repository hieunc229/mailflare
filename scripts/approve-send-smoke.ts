/**
 * Checks the `approve_send` MCP tool end to end against a real database, with no server and no network:
 * the per-key flag, own-drafts-only ownership, idempotency, expiry, the audit row, and that exactly one
 * message leaves each approval.
 * Run with `node scripts/run-ts.mjs scripts/approve-send-smoke.ts [DATABASE_URL]`; PGlite needs no server
 * (`pglite://memory` is the default).
 */
import { and, eq } from "drizzle-orm";
import { createDb } from "@/db";
import { agentDraftMetadata, agentSendApprovals, apiKeys, auditLogs, domains, mailboxes, messages, users } from "@/db/schema";
import { getDatabaseConfig } from "@/db/with-database";
import { openExternalDatabase } from "@/db/external";
import { applyPendingMigrations } from "@/lib/migrations/service";
import { requestAgentSend } from "@/lib/agent/approvals/utils";
import { approveAgentSend } from "@/lib/mcp/approve-send";
import type { McpPrincipal } from "@/lib/mcp/types";

const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean) => {
	checks.push([name, ok]);
	console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
};

const url = process.argv[2] ?? "pglite://memory";
const config = getDatabaseConfig({ DATABASE_URL: url } as never);
const external = openExternalDatabase(config, true);
const d1 = external as unknown as D1Database;
console.log(`dialect=${config.dialect} driver=${config.driver}`);

const applied = await applyPendingMigrations(d1);
check("migrations apply", applied.ready);

/** The queue the send pipeline hands a scheduled delivery to; a real deployment has Cloudflare Queues. */
const deliveries: Array<{ messageId: string }> = [];
const env = {
	DB: d1,
	APP_URL: "https://mailflare.test",
	OUTBOUND_QUEUE: { send: async (message: { messageId: string }) => { deliveries.push(message); } },
} as unknown as CloudflareEnv;

const db = createDb(d1);
const stamp = Date.now();
const userId = `usr_${stamp}`;
const mailboxId = `mbx_${stamp}`;
const domainId = `dom_${stamp}`;
const hostname = `ap${stamp}.example.com`;
const senderAddr = `me@${hostname}`;

await db.insert(users).values({ id: userId, email: `ap${stamp}@example.com`, passwordHash: "x", name: "Owner" });
const [user] = await db.select().from(users).where(eq(users.id, userId));
await db.insert(domains).values({ id: domainId, userId, hostname, zoneId: "z", status: "active" });
await db.insert(mailboxes).values({ id: mailboxId, userId, domainId, localPart: "me" });

const ownKeyId = `key_own_${stamp}`;
const otherKeyId = `key_other_${stamp}`;
const unflaggedKeyId = `key_flagless_${stamp}`;
const keyRow = (id: string, canApproveOwnSends: boolean) => ({ id, kind: "mcp" as const, userId, name: id, prefix: id.slice(0, 12), keyHash: "h", keySha256: id, scopes: JSON.stringify(["mcp:request-send"]), canApproveOwnSends });
await db.insert(apiKeys).values([keyRow(ownKeyId, true), keyRow(otherKeyId, true), keyRow(unflaggedKeyId, false)]);

const principal = (keyId: string, canApproveOwnSends = true): McpPrincipal => ({
	keyId,
	user: user as never,
	scopes: ["mcp:request-send"],
	mailboxIds: [mailboxId],
	canApproveOwnSends,
});

/** A draft the MCP key wrote, dated an hour out so the send pipeline enqueues instead of calling a provider. */
async function agentDraft(suffix: string, origin: "mcp" | "chat" = "mcp") {
	const draftId = `msg_${stamp}_${suffix}`;
	await db.insert(messages).values({
		id: draftId, userId, mailboxId, direction: "outbound", fromAddr: senderAddr,
		toAddr: `friend-${suffix}@example.com`, subject: `Hello ${suffix}`, textBody: "Body text", status: "draft",
	} as never);
	await db.insert(agentDraftMetadata).values({ draftId, mailboxId, origin, revision: 1, scheduledAt: new Date(Date.now() + 3_600_000) } as never);
	return draftId;
}

const queuedMessages = async () => db.select({ id: messages.id }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.status, "queued")));
const approvalRow = async (id: string) => (await db.select().from(agentSendApprovals).where(eq(agentSendApprovals.id, id)).limit(1))[0];

// 1. Flag off: denied, and nothing about the approval changes.
const draftA = await agentDraft("a");
const requestA = await requestAgentSend(env, user as never, draftA, 1, ownKeyId);
const denied = await approveAgentSend(env, principal(ownKeyId, false), { mailboxId, approvalId: requestA.approvalId });
check("flag off is denied", !denied.ok && /may not approve/.test(denied.error) && denied.code === "permission_denied");
check("flag off changed nothing", (await queuedMessages()).length === 0 && (await approvalRow(requestA.approvalId)).status === "pending" && deliveries.length === 0);

// 2. The key's own request: approved, and exactly one message leaves.
const approved = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestA.approvalId });
const approvedMessageId = approved.ok ? approved.messageId : null;
const afterApproval = await approvalRow(requestA.approvalId);
check("own draft is approved", approved.ok && approved.status === "queued" && !!approvedMessageId);
check("exactly one message was created", (await queuedMessages()).length === 1 && (await queuedMessages())[0].id === approvedMessageId);
check("exactly one delivery was queued", deliveries.length === 1 && deliveries[0].messageId === approvedMessageId);
check("approval records the send and the message", afterApproval.status === "sent" && afterApproval.messageId === approvedMessageId);

// 3. A second call returns the same status and sends nothing again.
const again = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestA.approvalId });
check("second call is idempotent", again.ok && again.status === "queued" && again.messageId === approvedMessageId);
check("second call sent nothing", (await queuedMessages()).length === 1 && deliveries.length === 1);

// 4. Another key's approval: denied, still pending.
const draftB = await agentDraft("b");
const requestB = await requestAgentSend(env, user as never, draftB, 1, otherKeyId);
const foreign = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestB.approvalId });
check("another key's approval is denied", !foreign.ok && /not found/i.test(foreign.error) && foreign.code === "not_found");
check("another key's approval is untouched", (await approvalRow(requestB.approvalId)).status === "pending" && (await queuedMessages()).length === 1);

// 5. A request made in the web UI (no key on it): denied.
const draftC = await agentDraft("c", "chat");
const requestC = await requestAgentSend(env, user as never, draftC, 1);
check("a UI request carries no key", (await approvalRow(requestC.approvalId)).requestKeyId === null);
const ui = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestC.approvalId });
check("UI-created approval is denied", !ui.ok && /not found/i.test(ui.error) && (await queuedMessages()).length === 1);

// 6. Expired: denied the way the review page treats it, never resurrected.
const draftD = await agentDraft("d");
const requestD = await requestAgentSend(env, user as never, draftD, 1, ownKeyId);
await db.update(agentSendApprovals).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(agentSendApprovals.id, requestD.approvalId));
const expired = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestD.approvalId });
check("expired approval is denied", !expired.ok && /expired/i.test(expired.error));
// "Expired" is its own answer, not a permissions problem the caller cannot act on.
check("expired is distinguishable from a refusal", !expired.ok && expired.code === "expired" && expired.status === "expired");
check("expired approval is marked expired, not sent", (await approvalRow(requestD.approvalId)).status === "expired" && (await queuedMessages()).length === 1);

// 6b. A request another confirmation has already claimed is a decided answer, not an error: the caller
// gets the state it settled on, and nothing is delivered.
const draftE = await agentDraft("e");
const requestE = await requestAgentSend(env, user as never, draftE, 1, ownKeyId);
await db.update(agentSendApprovals).set({ status: "claimed", claimedAt: new Date() }).where(eq(agentSendApprovals.id, requestE.approvalId));
const inFlight = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestE.approvalId });
check("an in-flight request returns its status, not an error", inFlight.ok && inFlight.status === "claimed" && inFlight.messageId === null);
check("an in-flight request is not sent twice", deliveries.length === 1 && (await queuedMessages()).length === 1);
// A request cancelled with its key is also a decided answer.
await db.update(agentSendApprovals).set({ status: "cancelled" }).where(eq(agentSendApprovals.id, requestE.approvalId));
const cancelled = await approveAgentSend(env, principal(ownKeyId), { mailboxId, approvalId: requestE.approvalId });
check("a cancelled request returns its status, not an error", cancelled.ok && cancelled.status === "cancelled" && deliveries.length === 1);

// 7. Audit: the approval, the key, a timestamp and the resulting message id.
const auditRows = await db.select().from(auditLogs).where(eq(auditLogs.action, "email.approve_send"));
const auditForA = auditRows.map((row) => ({ row, metadata: JSON.parse(row.metadata ?? "{}") as Record<string, unknown> }))
	.filter(({ metadata }) => metadata.approvalId === requestA.approvalId);
check("approval is audited", auditForA.length >= 1);
check("audit names the key id", auditForA.every(({ metadata }) => metadata.keyId === ownKeyId));
check("audit names the message id", auditForA.every(({ metadata }) => metadata.messageId === approvedMessageId && metadata.status === "queued"));
check("audit actor and timestamp", auditForA.every(({ row }) => row.actorUserId === userId && row.mailboxId === mailboxId && row.messageId === approvedMessageId && row.createdAt instanceof Date && Math.abs(row.createdAt.getTime() - Date.now()) < 120_000));
check("expired attempt is audited", auditRows.some((row) => JSON.parse(row.metadata ?? "{}").approvalId === requestD.approvalId));

await external.sqlExecutor.close?.();
const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
