import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { AuditLogInput } from "./types";

export async function createAuditLog(env: CloudflareEnv, input: AuditLogInput): Promise<void> {
	await createAuditLogs(env, [input]);
}

export async function createAuditLogs(env: CloudflareEnv, inputs: AuditLogInput[]): Promise<void> {
	if (inputs.length === 0) return;
	const db = getDb(env);
	// Keep each insert well under the dialects' bound-parameter limits.
	for (let index = 0; index < inputs.length; index += 10) {
		await db.insert(auditLogs).values(inputs.slice(index, index + 10).map((input) => ({
			id: newId("aud"),
			actorUserId: input.actorUserId ?? null,
			targetUserId: input.targetUserId ?? null,
			mailboxId: input.mailboxId ?? null,
			messageId: input.messageId ?? null,
			action: input.action,
			metadata: input.metadata ? JSON.stringify(input.metadata) : null,
		})));
	}
}
