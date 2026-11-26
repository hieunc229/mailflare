import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { containsLike } from "@/db/sql";
import { domains, emailSuppressions, mailGroupMembers, mailGroups, mailboxes, users } from "@/db/schema";
import { domainOwnerIdsForAdmin } from "@/app/api/accounts/utils";
import { deleteEmailRoutingRuleForAddress, ensureEmailRoutingRuleToWorker, rollbackEmailRoutingRuleChanges } from "@/lib/cloudflare-api";
import type { CfEmailRoutingRuleChange } from "@/lib/cloudflare-api.types";
import { isMissingTableError, isUniqueConstraintError } from "@/lib/database-errors";
import { isReportAddressReserved } from "@/lib/deliverability/report-address";
import { normalizeRecipientLocalPart } from "@/lib/email/recipient-address";
import { newId } from "@/lib/ids";
import { domainCanSend } from "@/lib/groups/sending";
import { createAuditLog, createAuditLogs } from "@/lib/mailboxes/audit";
import { findAddressOwner } from "@/lib/mailboxes/address-owner";
import type { AuditLogInput } from "@/lib/mailboxes/types";
import {
	CAN_SEND_AS_UNAVAILABLE,
	MAX_EXTERNAL_MEMBERS,
	MAX_GROUPS_PER_DOMAIN,
	MAX_GROUP_MEMBERS,
	MEMBER_INSERT_CHUNK,
	chunk,
	groupAddress,
	validateMember,
	type MemberInput,
	type ValidMember,
} from "./members-utils";
import type { GroupActor, GroupCandidate, GroupMemberView, GroupResult, GroupSummary } from "./types";

type GroupRow = typeof mailGroups.$inferSelect;
type DomainRow = typeof domains.$inferSelect;
type MemberRow = typeof mailGroupMembers.$inferSelect;

const IN_CHUNK = 50;
const fail = (status: number, error: string, code?: string): { ok: false; status: number; error: string; code?: string } => ({ ok: false, status, error, ...(code ? { code } : {}) });
const ok = <T>(data: T): GroupResult<T> => ({ ok: true, data });

const OWNER_MESSAGES = {
	mailbox: "A mailbox already uses this address",
	alias: "An alias already uses this address",
	group: "A group already uses this address",
} as const;

async function usableDomains(db: AppDatabase, actor: GroupActor): Promise<DomainRow[]> {
	return db.select().from(domains).where(inArray(domains.userId, domainOwnerIdsForAdmin(actor))).orderBy(asc(domains.hostname));
}

async function usableDomain(db: AppDatabase, actor: GroupActor, domainId: string): Promise<DomainRow | null> {
	const [domain] = await db.select().from(domains).where(and(eq(domains.id, domainId), inArray(domains.userId, domainOwnerIdsForAdmin(actor)))).limit(1);
	return domain ?? null;
}

async function loadOwnedGroup(db: AppDatabase, actor: GroupActor, id: string): Promise<{ group: GroupRow; domain: DomainRow } | null> {
	const [row] = await db
		.select({ group: mailGroups, domain: domains })
		.from(mailGroups)
		.innerJoin(domains, eq(mailGroups.domainId, domains.id))
		.where(and(eq(mailGroups.id, id), inArray(domains.userId, domainOwnerIdsForAdmin(actor))))
		.limit(1);
	return row ?? null;
}

function summarize(group: GroupRow, domain: Pick<DomainRow, "hostname" | "sendingProvider" | "sendingEnabled">, memberCount: number): GroupSummary {
	return {
		id: group.id,
		domainId: group.domainId,
		hostname: domain.hostname,
		localPart: group.localPart,
		address: groupAddress(group.localPart, domain.hostname),
		name: group.name,
		description: group.description,
		whoCanPost: group.whoCanPost,
		replyTo: group.replyTo,
		disabled: group.disabled,
		memberCount,
		canSend: domainCanSend(domain),
		createdAt: new Date(group.createdAt).toISOString(),
	};
}

async function countMembers(db: AppDatabase, groupId: string): Promise<number> {
	const [row] = await db.select({ n: sql<number>`count(*)` }).from(mailGroupMembers).where(eq(mailGroupMembers.groupId, groupId));
	return Number(row?.n ?? 0);
}

async function countExternal(db: AppDatabase, groupId: string): Promise<number> {
	const [row] = await db.select({ n: sql<number>`count(*)` }).from(mailGroupMembers).where(and(eq(mailGroupMembers.groupId, groupId), eq(mailGroupMembers.kind, "external")));
	return Number(row?.n ?? 0);
}

const externalCapMessage = () => `A group holds at most ${MAX_EXTERNAL_MEMBERS} external members`;

/** Why an address cannot become a group's, or null. */
async function addressConflict(env: CloudflareEnv, db: AppDatabase, domain: DomainRow, localPart: string): Promise<string | null> {
	if (await isReportAddressReserved(env, domain.id, localPart)) return "This address is reserved for DMARC reports";
	const owner = await findAddressOwner(db, domain.id, localPart, { allDomains: {} });
	return owner ? OWNER_MESSAGES[owner] : null;
}

/**
 * Another group on the domain whose normalized address equals this one (john and j.ohn route alike). Groups
 * only: a mailbox or alias created at the same moment as a dotted group variant is not covered. The
 * pre-insert check cannot see a concurrent request, so create and update look again once their own row
 * is stored and the loser backs out; two racing requests may both back out, and a retry then succeeds.
 */
async function normalizedClash(db: AppDatabase, domainId: string, localPart: string, exceptId: string): Promise<boolean> {
	const wanted = normalizeRecipientLocalPart(localPart);
	const rows = await db.select({ id: mailGroups.id, localPart: mailGroups.localPart }).from(mailGroups).where(eq(mailGroups.domainId, domainId));
	return rows.some((row) => row.id !== exceptId && normalizeRecipientLocalPart(row.localPart) === wanted);
}

async function rollbackRules(env: CloudflareEnv, changes: CfEmailRoutingRuleChange[]) {
	try {
		await rollbackEmailRoutingRuleChanges(env, changes);
	} catch (error) {
		console.error("rollbackEmailRoutingRuleChanges", error);
	}
}

async function removeRule(env: CloudflareEnv, domain: DomainRow, address: string) {
	if (domain.receivingProvider !== "cloudflare") return;
	try {
		await deleteEmailRoutingRuleForAddress(env, domain.zoneId, address);
	} catch (error) {
		console.error("deleteEmailRoutingRuleForAddress", error);
	}
}

export async function listGroups(db: AppDatabase, actor: GroupActor) {
	const available = await usableDomains(db, actor);
	const byId = new Map(available.map((domain) => [domain.id, domain]));
	const rows: GroupRow[] = [];
	for (const part of chunk([...byId.keys()], IN_CHUNK)) rows.push(...(await db.select().from(mailGroups).where(inArray(mailGroups.domainId, part))));
	const counts = new Map<string, number>();
	for (const part of chunk(rows.map((row) => row.id), IN_CHUNK)) {
		const found = await db
			.select({ groupId: mailGroupMembers.groupId, n: sql<number>`count(*)` })
			.from(mailGroupMembers)
			.where(inArray(mailGroupMembers.groupId, part))
			.groupBy(mailGroupMembers.groupId);
		for (const row of found) counts.set(row.groupId, Number(row.n));
	}
	const groups = rows
		.map((row) => summarize(row, byId.get(row.domainId)!, counts.get(row.id) ?? 0))
		.sort((a, b) => a.address.localeCompare(b.address));
	return ok({ groups, domains: available.map((domain) => ({ id: domain.id, hostname: domain.hostname })) });
}

/** Which of the addresses are on the domain's confirmed suppression list. Empty before that migration is applied. */
async function suppressedAmong(db: AppDatabase, domainId: string, emails: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	try {
		for (const part of chunk([...new Set(emails)], IN_CHUNK)) {
			const rows = await db
				.select({ email: emailSuppressions.email })
				.from(emailSuppressions)
				.where(and(eq(emailSuppressions.domainId, domainId), eq(emailSuppressions.confirmed, true), inArray(emailSuppressions.email, part)));
			for (const row of rows) found.add(row.email);
		}
	} catch (error) {
		if (!isMissingTableError(error)) throw error;
	}
	return found;
}

async function describeMembers(db: AppDatabase, domainId: string, rows: MemberRow[]): Promise<GroupMemberView[]> {
	const userIds = [...new Set(rows.flatMap((row) => (row.userId ? [row.userId] : [])))];
	const mailboxIds = [...new Set(rows.flatMap((row) => (row.mailboxId ? [row.mailboxId] : [])))];
	const userRows = new Map<string, { name: string; email: string; disabled: boolean }>();
	for (const part of chunk(userIds, IN_CHUNK)) {
		for (const row of await db.select({ id: users.id, name: users.name, email: users.email, disabled: users.disabled }).from(users).where(inArray(users.id, part))) userRows.set(row.id, row);
	}
	const mailboxRows = new Map<string, { name: string; address: string }>();
	for (const part of chunk(mailboxIds, IN_CHUNK)) {
		const found = await db
			.select({ id: mailboxes.id, localPart: mailboxes.localPart, displayName: mailboxes.displayName, hostname: domains.hostname })
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id))
			.where(inArray(mailboxes.id, part));
		for (const row of found) mailboxRows.set(row.id, { name: row.displayName || row.localPart, address: groupAddress(row.localPart, row.hostname) });
	}
	const suppressed = await suppressedAmong(db, domainId, rows.flatMap((row) => (row.kind === "external" && row.email ? [row.email] : [])));
	return rows.map((row) => {
		const account = row.userId ? userRows.get(row.userId) : undefined;
		const mailbox = row.mailboxId ? mailboxRows.get(row.mailboxId) : undefined;
		return {
			id: row.id,
			kind: row.kind,
			userId: row.userId,
			mailboxId: row.mailboxId,
			email: row.email,
			canSendAs: row.canSendAs,
			name: account?.name ?? mailbox?.name ?? row.email ?? "",
			address: account?.email ?? mailbox?.address ?? row.email ?? "",
			disabled: account?.disabled ?? false,
			suppressed: row.kind === "external" && !!row.email && suppressed.has(row.email),
			createdAt: new Date(row.createdAt).toISOString(),
		};
	});
}

export async function getGroup(db: AppDatabase, actor: GroupActor, id: string) {
	const found = await loadOwnedGroup(db, actor, id);
	if (!found) return fail(404, "Group not found");
	const rows = await db.select().from(mailGroupMembers).where(eq(mailGroupMembers.groupId, id)).orderBy(asc(mailGroupMembers.createdAt), asc(mailGroupMembers.id));
	const members = await describeMembers(db, found.group.domainId, rows);
	members.sort((a, b) => a.name.localeCompare(b.name));
	return ok({ group: summarize(found.group, found.domain, rows.length), members });
}

type CreateInput = { domainId: string; localPart: string; name: string; description?: string | null; whoCanPost: GroupRow["whoCanPost"]; replyTo: GroupRow["replyTo"] };

export async function createGroup(env: CloudflareEnv, db: AppDatabase, actor: GroupActor, input: CreateInput) {
	const domain = await usableDomain(db, actor, input.domainId);
	if (!domain) return fail(404, "Domain not found");
	const localPart = input.localPart.toLowerCase();
	const conflict = await addressConflict(env, db, domain, localPart);
	if (conflict) return fail(409, conflict);
	const [existing] = await db.select({ n: sql<number>`count(*)` }).from(mailGroups).where(eq(mailGroups.domainId, domain.id));
	if (Number(existing?.n ?? 0) >= MAX_GROUPS_PER_DOMAIN) return fail(422, `A domain holds at most ${MAX_GROUPS_PER_DOMAIN} groups`);

	const id = newId("grp");
	try {
		await db.insert(mailGroups).values({
			id,
			domainId: domain.id,
			localPart,
			name: input.name,
			description: input.description?.trim() || null,
			whoCanPost: input.whoCanPost,
			replyTo: input.replyTo,
			createdByUserId: actor.id,
		});
	} catch (error) {
		if (isUniqueConstraintError(error)) return fail(409, OWNER_MESSAGES.group);
		throw error;
	}
	const address = groupAddress(localPart, domain.hostname);
	const changes: CfEmailRoutingRuleChange[] = [];
	try {
		if (domain.receivingProvider === "cloudflare") await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address, changes);
	} catch (error) {
		await rollbackRules(env, changes);
		await db.delete(mailGroups).where(eq(mailGroups.id, id));
		return fail(502, error instanceof Error ? error.message : "Failed to create Cloudflare routing rule");
	}
	if (await normalizedClash(db, domain.id, localPart, id)) {
		await rollbackRules(env, changes);
		await db.delete(mailGroups).where(eq(mailGroups.id, id));
		return fail(409, OWNER_MESSAGES.group);
	}
	await createAuditLog(env, { actorUserId: actor.id, action: "group.created", metadata: { groupId: id, address } });
	const [row] = await db.select().from(mailGroups).where(eq(mailGroups.id, id)).limit(1);
	return ok(summarize(row, domain, 0));
}

type UpdateInput = Partial<Pick<CreateInput, "domainId" | "localPart" | "name" | "whoCanPost" | "replyTo">> & { description?: string | null; disabled?: boolean };

export async function updateGroup(env: CloudflareEnv, db: AppDatabase, actor: GroupActor, id: string, input: UpdateInput) {
	const found = await loadOwnedGroup(db, actor, id);
	if (!found) return fail(404, "Group not found");
	const { group, domain: oldDomain } = found;
	const oldAddress = groupAddress(group.localPart, oldDomain.hostname);

	let domain = oldDomain;
	if (input.domainId && input.domainId !== group.domainId) {
		const next = await usableDomain(db, actor, input.domainId);
		if (!next) return fail(404, "Domain not found");
		domain = next;
	}
	const localPart = (input.localPart ?? group.localPart).toLowerCase();
	const address = groupAddress(localPart, domain.hostname);
	const addressChanged = address !== oldAddress;
	// Keeping the same normalized address (dots, +tags, case) is not a clash with itself.
	const sameClaim = domain.id === oldDomain.id && normalizeRecipientLocalPart(localPart) === normalizeRecipientLocalPart(group.localPart);
	if (addressChanged && !sameClaim) {
		const conflict = await addressConflict(env, db, domain, localPart);
		if (conflict) return fail(409, conflict);
	}
	if (domain.id !== oldDomain.id) {
		const [existing] = await db.select({ n: sql<number>`count(*)` }).from(mailGroups).where(eq(mailGroups.domainId, domain.id));
		if (Number(existing?.n ?? 0) >= MAX_GROUPS_PER_DOMAIN) return fail(422, `A domain holds at most ${MAX_GROUPS_PER_DOMAIN} groups`);
	}

	const description = input.description === undefined ? group.description : input.description?.trim() || null;
	const next = {
		localPart,
		domainId: domain.id,
		name: input.name ?? group.name,
		description,
		whoCanPost: input.whoCanPost ?? group.whoCanPost,
		replyTo: input.replyTo ?? group.replyTo,
		disabled: input.disabled ?? group.disabled,
	};
	const changed = (["localPart", "domainId", "name", "description", "whoCanPost", "replyTo", "disabled"] as const).filter((key) => {
		if (key === "localPart") return addressChanged && localPart !== group.localPart;
		return next[key] !== group[key];
	});
	if (!changed.length) return ok(summarize(group, oldDomain, await countMembers(db, id)));

	const changes: CfEmailRoutingRuleChange[] = [];
	if (addressChanged) {
		try {
			if (domain.receivingProvider === "cloudflare") await ensureEmailRoutingRuleToWorker(env, domain.zoneId, address, changes);
		} catch (error) {
			await rollbackRules(env, changes);
			return fail(502, error instanceof Error ? error.message : "Failed to create Cloudflare routing rule");
		}
	}
	try {
		await db.update(mailGroups).set({ ...next, updatedAt: new Date() }).where(eq(mailGroups.id, id));
	} catch (error) {
		await rollbackRules(env, changes);
		if (isUniqueConstraintError(error)) return fail(409, OWNER_MESSAGES.group);
		throw error;
	}
	if (addressChanged && !sameClaim && (await normalizedClash(db, domain.id, localPart, id))) {
		// The new rule goes first: it must not outlive a failed restore. Then put back every field this update wrote.
		await rollbackRules(env, changes);
		try {
			await db.update(mailGroups).set({
				localPart: group.localPart,
				domainId: group.domainId,
				name: group.name,
				description: group.description,
				whoCanPost: group.whoCanPost,
				replyTo: group.replyTo,
				disabled: group.disabled,
				updatedAt: group.updatedAt,
			}).where(eq(mailGroups.id, id));
		} catch (error) {
			// The old address was taken in the meantime: nothing safe to restore to, so report the clash.
			if (!isUniqueConstraintError(error)) throw error;
		}
		return fail(409, OWNER_MESSAGES.group);
	}
	if (addressChanged) await removeRule(env, oldDomain, oldAddress);
	await createAuditLog(env, {
		actorUserId: actor.id,
		action: "group.updated",
		metadata: { groupId: id, address, ...(addressChanged ? { previousAddress: oldAddress } : {}), changed },
	});
	const [row] = await db.select().from(mailGroups).where(eq(mailGroups.id, id)).limit(1);
	return ok(summarize(row, domain, await countMembers(db, id)));
}

export async function deleteGroup(env: CloudflareEnv, db: AppDatabase, actor: GroupActor, id: string) {
	const found = await loadOwnedGroup(db, actor, id);
	if (!found) return fail(404, "Group not found");
	const address = groupAddress(found.group.localPart, found.domain.hostname);
	// One batch, so a failure never leaves a group without its members.
	await db.batch([db.delete(mailGroupMembers).where(eq(mailGroupMembers.groupId, id)), db.delete(mailGroups).where(eq(mailGroups.id, id))] as never);
	await removeRule(env, found.domain, address);
	await createAuditLog(env, { actorUserId: actor.id, action: "group.deleted", metadata: { groupId: id, address } });
	return ok({ id });
}

type AddResult = { added: GroupMemberView[]; skipped: { index: number; reason: "already_member" }[] };

export async function addMembers(env: CloudflareEnv, db: AppDatabase, actor: GroupActor, id: string, inputs: MemberInput[]): Promise<GroupResult<AddResult>> {
	const found = await loadOwnedGroup(db, actor, id);
	if (!found) return fail(404, "Group not found");
	const address = groupAddress(found.group.localPart, found.domain.hostname);

	const checked: ValidMember[] = [];
	for (const input of inputs) {
		const result = validateMember(input);
		if (!result.ok) return fail(result.status, result.error);
		checked.push(result.member);
	}

	const userIds = [...new Set(checked.flatMap((member) => (member.kind === "user" ? [member.userId] : [])))];
	const mailboxIds = [...new Set(checked.flatMap((member) => (member.kind === "mailbox" ? [member.mailboxId] : [])))];
	const accounts = userIds.length
		? await db.select({ id: users.id, disabled: users.disabled, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, userIds))
		: [];
	const accountById = new Map(accounts.map((row) => [row.id, row]));
	for (const userId of userIds) {
		const account = accountById.get(userId);
		if (!account || account.deletedAt) return fail(422, "Account not found");
		if (account.disabled) return fail(422, "A disabled account cannot be a member");
	}
	const usableIds = new Set((await usableDomains(db, actor)).map((domain) => domain.id));
	const boxes = mailboxIds.length
		? await db.select({ id: mailboxes.id, type: mailboxes.type, domainId: mailboxes.domainId }).from(mailboxes).where(inArray(mailboxes.id, mailboxIds))
		: [];
	const boxById = new Map(boxes.map((row) => [row.id, row]));
	for (const mailboxId of mailboxIds) {
		const box = boxById.get(mailboxId);
		if (!box || !usableIds.has(box.domainId)) return fail(422, "Mailbox not found");
		if (box.type !== "shared") return fail(422, "Only shared mailboxes can be members; add the account instead");
	}

	const emails = [...new Set(checked.flatMap((member) => (member.kind === "external" ? [member.email] : [])))];
	if (emails.some((email) => email === address)) return fail(422, "The group's own address cannot be a member");
	if (emails.length) {
		// Mail to our own domains never leaves the installation: an account or shared mailbox member gets it directly.
		const hostnames = [...new Set(emails.map((email) => email.slice(email.lastIndexOf("@") + 1)))];
		const own = new Set<string>();
		for (const part of chunk(hostnames, IN_CHUNK)) for (const row of await db.select({ hostname: domains.hostname }).from(domains).where(inArray(domains.hostname, part))) own.add(row.hostname.toLowerCase());
		const clash = emails.find((email) => own.has(email.slice(email.lastIndexOf("@") + 1)));
		if (clash) return fail(422, `${clash.slice(clash.lastIndexOf("@") + 1)} is one of your domains; add the account or shared mailbox as a member instead`);
	}

	const existingRows = userIds.length || mailboxIds.length || emails.length
		? await db
			.select({ userId: mailGroupMembers.userId, mailboxId: mailGroupMembers.mailboxId, email: mailGroupMembers.email })
			.from(mailGroupMembers)
			.where(and(
				eq(mailGroupMembers.groupId, id),
				or(
					userIds.length ? inArray(mailGroupMembers.userId, userIds) : undefined,
					mailboxIds.length ? inArray(mailGroupMembers.mailboxId, mailboxIds) : undefined,
					emails.length ? inArray(mailGroupMembers.email, emails) : undefined,
				),
			))
		: [];
	const seen = new Set(existingRows.map((row) => row.userId ?? row.mailboxId ?? row.email));
	const skipped: AddResult["skipped"] = [];
	const fresh: { index: number; member: ValidMember }[] = [];
	checked.forEach((member, index) => {
		const key = member.kind === "user" ? member.userId : member.kind === "mailbox" ? member.mailboxId : member.email;
		if (seen.has(key)) return void skipped.push({ index, reason: "already_member" });
		seen.add(key);
		fresh.push({ index, member });
	});
	if (!fresh.length) return ok({ added: [], skipped });
	if ((await countMembers(db, id)) + fresh.length > MAX_GROUP_MEMBERS) return fail(422, `A group holds at most ${MAX_GROUP_MEMBERS} members`);
	const freshExternal = fresh.filter(({ member }) => member.kind === "external").length;
	if (freshExternal && (await countExternal(db, id)) + freshExternal > MAX_EXTERNAL_MEMBERS) return fail(422, externalCapMessage());

	const rows = fresh.map(({ member }) => ({
		id: newId("gmb"),
		groupId: id,
		kind: member.kind,
		userId: member.kind === "user" ? member.userId : null,
		mailboxId: member.kind === "mailbox" ? member.mailboxId : null,
		email: member.kind === "external" ? member.email : null,
		canSendAs: member.canSendAs,
		createdByUserId: actor.id,
	}));
	try {
		// One batch, so a conflict part-way through stores none of them.
		await db.batch(chunk(rows, MEMBER_INSERT_CHUNK).map((part) => db.insert(mailGroupMembers).values(part)) as never);
	} catch (error) {
		if (isUniqueConstraintError(error)) return fail(409, "A member was added at the same time; reload and try again");
		throw error;
	}
	// The cap check above cannot see a concurrent add, so count again and back out if this one overflowed it.
	if ((await countMembers(db, id)) > MAX_GROUP_MEMBERS) {
		await db.batch(chunk(rows.map((row) => row.id), IN_CHUNK).map((part) => db.delete(mailGroupMembers).where(inArray(mailGroupMembers.id, part))) as never);
		return fail(422, `A group holds at most ${MAX_GROUP_MEMBERS} members`);
	}
	if (freshExternal && (await countExternal(db, id)) > MAX_EXTERNAL_MEMBERS) {
		await db.batch(chunk(rows.map((row) => row.id), IN_CHUNK).map((part) => db.delete(mailGroupMembers).where(inArray(mailGroupMembers.id, part))) as never);
		return fail(422, externalCapMessage());
	}
	const stored: MemberRow[] = [];
	for (const part of chunk(rows.map((row) => row.id), IN_CHUNK)) stored.push(...(await db.select().from(mailGroupMembers).where(inArray(mailGroupMembers.id, part))));
	const added = await describeMembers(db, found.group.domainId, stored);
	await createAuditLogs(env, rows.map((row): AuditLogInput => ({
		actorUserId: actor.id,
		targetUserId: row.userId,
		mailboxId: row.mailboxId,
		action: "group.member_added",
		metadata: { groupId: id, address, kind: row.kind, ...(row.email ? { email: row.email } : {}) },
	})));
	return ok({ added, skipped });
}

async function loadMember(db: AppDatabase, actor: GroupActor, id: string, memberId: string) {
	const found = await loadOwnedGroup(db, actor, id);
	if (!found) return null;
	const [member] = await db.select().from(mailGroupMembers).where(and(eq(mailGroupMembers.id, memberId), eq(mailGroupMembers.groupId, id))).limit(1);
	return member ? { ...found, member, address: groupAddress(found.group.localPart, found.domain.hostname) } : null;
}

export async function updateMember(env: CloudflareEnv, db: AppDatabase, actor: GroupActor, id: string, memberId: string, input: { canSendAs: boolean }) {
	const found = await loadMember(db, actor, id, memberId);
	if (!found) return fail(404, "Member not found");
	if (input.canSendAs) return fail(422, CAN_SEND_AS_UNAVAILABLE);
	if (found.member.kind !== "user") return fail(422, "Only account members can be allowed to send as the group");
	await db.update(mailGroupMembers).set({ canSendAs: input.canSendAs }).where(eq(mailGroupMembers.id, memberId));
	await createAuditLog(env, {
		actorUserId: actor.id,
		targetUserId: found.member.userId,
		action: "group.member_updated",
		metadata: { groupId: id, address: found.address, kind: found.member.kind, canSendAs: input.canSendAs },
	});
	const [row] = await db.select().from(mailGroupMembers).where(eq(mailGroupMembers.id, memberId)).limit(1);
	return ok((await describeMembers(db, found.group.domainId, [row]))[0]);
}

export async function removeMember(env: CloudflareEnv, db: AppDatabase, actor: GroupActor, id: string, memberId: string) {
	const found = await loadMember(db, actor, id, memberId);
	if (!found) return fail(404, "Member not found");
	await db.delete(mailGroupMembers).where(eq(mailGroupMembers.id, memberId));
	await createAuditLog(env, {
		actorUserId: actor.id,
		targetUserId: found.member.userId,
		mailboxId: found.member.mailboxId,
		action: "group.member_removed",
		metadata: { groupId: id, address: found.address, kind: found.member.kind },
	});
	return ok({ id: memberId });
}

const CANDIDATE_LIMIT = 20;

/** Accounts and shared mailboxes the admin may add, matching `q` and not already members. */
export async function searchCandidates(db: AppDatabase, actor: GroupActor, id: string, query: string): Promise<GroupResult<GroupCandidate[]>> {
	const found = await loadOwnedGroup(db, actor, id);
	if (!found) return fail(404, "Group not found");
	const term = query.trim().slice(0, 100);
	const memberRows = await db.select({ userId: mailGroupMembers.userId, mailboxId: mailGroupMembers.mailboxId }).from(mailGroupMembers).where(eq(mailGroupMembers.groupId, id));
	const taken = new Set(memberRows.map((row) => row.userId ?? row.mailboxId));
	const wanted = CANDIDATE_LIMIT + taken.size;

	const accounts = await db
		.select({ id: users.id, name: users.name, email: users.email })
		.from(users)
		.where(and(eq(users.disabled, false), isNull(users.deletedAt), term ? or(containsLike(users.email, term), containsLike(users.name, term)) : undefined))
		.orderBy(asc(users.name))
		.limit(Math.min(wanted, 520));
	const domainIds = (await usableDomains(db, actor)).map((domain) => domain.id);
	const boxes: { id: string; name: string; address: string }[] = [];
	for (const part of chunk(domainIds, IN_CHUNK)) {
		const rows = await db
			.select({ id: mailboxes.id, localPart: mailboxes.localPart, displayName: mailboxes.displayName, hostname: domains.hostname })
			.from(mailboxes)
			.innerJoin(domains, eq(mailboxes.domainId, domains.id))
			.where(and(eq(mailboxes.type, "shared"), inArray(mailboxes.domainId, part), term ? or(containsLike(mailboxes.localPart, term), containsLike(mailboxes.displayName, term)) : undefined))
			.orderBy(asc(mailboxes.localPart))
			.limit(Math.min(wanted, 520));
		for (const row of rows) boxes.push({ id: row.id, name: row.displayName || row.localPart, address: groupAddress(row.localPart, row.hostname) });
	}
	const candidates: GroupCandidate[] = [
		...accounts.filter((row) => !taken.has(row.id)).map((row): GroupCandidate => ({ kind: "user", id: row.id, name: row.name, address: row.email })),
		...boxes.filter((row) => !taken.has(row.id)).map((row): GroupCandidate => ({ kind: "mailbox", id: row.id, name: row.name, address: row.address })),
	];
	return ok(candidates.slice(0, CANDIDATE_LIMIT));
}
