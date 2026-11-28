import { getDb } from "@/db";
import { auditLogs } from "@/db/schema";
import { newId } from "@/lib/ids";
import type { AuditLogInput } from "./types";

export async function createAuditLog(env: CloudflareEnv, input: AuditLogInput): Promise<void> {
	await createAuditLogs(env, [input]);
}

/** The insert statements for audit rows, unexecuted, so a caller can send them in one `db.batch`. */
export function buildAuditLogInserts(db: ReturnType<typeof getDb>, inputs: AuditLogInput[]) {
	// Keep each insert well under the dialects' bound-parameter limits.
	const inserts: PromiseLike<unknown>[] = [];
	for (let index = 0; index < inputs.length; index += 10) {
		inserts.push(db.insert(auditLogs).values(inputs.slice(index, index + 10).map((input) => ({
			id: newId("aud"),
			actorUserId: input.actorUserId ?? null,
			targetUserId: input.targetUserId ?? null,
			mailboxId: input.mailboxId ?? null,
			messageId: input.messageId ?? null,
			action: input.action,
			metadata: input.metadata ? JSON.stringify(input.metadata) : null,
		}))));
	}
	return inserts;
}

export async function createAuditLogs(env: CloudflareEnv, inputs: AuditLogInput[]): Promise<void> {
	for (const insert of buildAuditLogInserts(getDb(env), inputs)) await insert;
}
