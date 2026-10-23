import { and, eq, inArray } from "drizzle-orm";
import { folders, mailboxes } from "@/db/schema";
import { listAccessibleMailboxes } from "@/lib/mailboxes/access";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import type { AccessibleMailbox, JmapContext } from "./types";

/** Every Mailflare mailbox the key's user can read, in a JMAP-shaped record. */
export function listJmapMailboxes(ctx: JmapContext): Promise<AccessibleMailbox[]> {
	if (ctx.memo === null) return loadJmapMailboxes(ctx);
	const memo = (ctx.memo ??= {});
	if (!memo.mailboxes) {
		const pending = loadJmapMailboxes(ctx);
		memo.mailboxes = pending;
		// A failed lookup is retried by the next call instead of failing it too.
		pending.catch(() => {
			if (memo.mailboxes === pending) memo.mailboxes = undefined;
		});
	}
	return memo.mailboxes;
}

async function loadJmapMailboxes(ctx: JmapContext): Promise<AccessibleMailbox[]> {
	const rows = await listAccessibleMailboxes(ctx.db, ctx.auth.user);
	return rows.filter((row) => !ctx.auth.mailboxIds || ctx.auth.mailboxIds.includes(row.id)).map((row) => ({
		id: row.id,
		userId: row.userId,
		localPart: row.localPart,
		hostname: row.hostname,
		displayName: row.displayName,
		permission: row.permission,
		type: row.type,
		isPrimary: row.isPrimary,
	}));
}

export async function listAccessibleMailboxIdSet(ctx: JmapContext): Promise<Set<string>> {
	return new Set((await listJmapMailboxes(ctx)).map((row) => row.id));
}

/** User folders for a set of mailboxes, keyed by mailbox id. */
export async function listFoldersByMailbox(ctx: JmapContext, mailboxIds: string[]): Promise<Map<string, Array<{ id: string; name: string }>>> {
	const result = new Map<string, Array<{ id: string; name: string }>>();
	if (mailboxIds.length === 0) return result;
	const rows = await ctx.db
		.select({ id: folders.id, mailboxId: folders.mailboxId, name: folders.name })
		.from(folders)
		.where(inArray(folders.mailboxId, mailboxIds));
	for (const row of rows) {
		const list = result.get(row.mailboxId) ?? [];
		list.push({ id: row.id, name: row.name });
		result.set(row.mailboxId, list);
	}
	return result;
}

/** Addresses each mailbox may send from, for Identity objects. */
export async function listSendableAddresses(ctx: JmapContext, mailbox: AccessibleMailbox): Promise<string[]> {
	const [row] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, mailbox.id))).limit(1);
	if (!row) return [];
	return getMailboxDomainAddresses(ctx.db, row);
}
