import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { appSettings, domains, mailboxes, users } from "@/db/schema";
import { isMissingColumnError } from "@/lib/database-errors";
import { getLicenseEntitlements } from "@/lib/licenses/service";
import { grantedCalendars } from "./shares";

/** Addresses or people per statement: two lists of this size plus two equality conditions stay under D1's 100 bound parameters. */
const CHUNK = 40;

/**
 * Organisation-wide free/busy (D-10, D-13): the administrator's switch AND a Team licence. A lapsed licence behaves as off, and so
 * does a database that has not run the migration yet.
 */
export async function isOrgFreeBusyEnabled(env: CloudflareEnv): Promise<boolean> {
	let on = false;
	try {
		const [row] = await getDb(env).select({ on: appSettings.calendarOrgFreeBusy }).from(appSettings).where(eq(appSettings.id, "default")).limit(1);
		on = !!row?.on;
	} catch (error) {
		if (!isMissingColumnError(error)) throw error;
	}
	return on && (await getLicenseEntitlements(env)).canShareMailboxes;
}

const normalize = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");

/**
 * Address to account id, for sign-in addresses and personal mailboxes (the same two the share dialog accepts). Says nothing about
 * whether the account may be seen: that is `viewableFreeBusyUsers`. Anything unknown, malformed or not a personal mailbox is absent.
 */
export async function resolveFreeBusyAddresses(env: CloudflareEnv, addresses: string[]): Promise<Map<string, string>> {
	const db = getDb(env);
	const wanted = [...new Set(addresses.map(normalize))].filter((address) => {
		const at = address.lastIndexOf("@");
		return at >= 1 && at < address.length - 1 && address.length <= 254;
	});
	const found = new Map<string, string>();
	for (let index = 0; index < wanted.length; index += CHUNK) {
		const chunk = wanted.slice(index, index + CHUNK);
		for (const row of await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.email, chunk))) found.set(row.email.toLowerCase(), row.id);
		const rest = chunk.filter((address) => !found.has(address));
		if (!rest.length) continue;
		const rows = await db.select({ id: mailboxes.userId, localPart: mailboxes.localPart, hostname: domains.hostname }).from(mailboxes).innerJoin(domains, eq(domains.id, mailboxes.domainId))
			.where(and(inArray(mailboxes.localPart, [...new Set(rest.map((address) => address.slice(0, address.lastIndexOf("@"))))]), inArray(domains.hostname, [...new Set(rest.map((address) => address.slice(address.lastIndexOf("@") + 1)))]), eq(mailboxes.type, "personal"), eq(mailboxes.disabled, false)));
		for (const row of rows) {
			const address = `${row.localPart}@${row.hostname}`.toLowerCase();
			if (rest.includes(address) && !found.has(address)) found.set(address, row.id);
		}
	}
	return new Map(wanted.filter((address) => found.has(address)).map((address) => [address, found.get(address)!]));
}

/**
 * Which of `targetIds` the viewer may see the busy times of (D-10): themselves; anyone who owns a calendar the viewer holds any
 * grant on (free/busy included); and, when organisation-wide free/busy is on, every active account with Calendar on. A grant from a
 * disabled owner or one with Calendar off opens nothing.
 */
export async function viewableFreeBusyUsers(env: CloudflareEnv, viewerId: string, targetIds: string[]): Promise<Set<string>> {
	const db = getDb(env);
	const targets = [...new Set(targetIds)];
	const allowed = new Set<string>();
	if (targets.includes(viewerId)) allowed.add(viewerId);
	let rest = targets.filter((id) => !allowed.has(id));
	if (!rest.length) return allowed;
	const owners = new Set((await grantedCalendars(db, viewerId)).map((grant) => grant.ownerId));
	for (const id of rest) if (owners.has(id)) allowed.add(id);
	rest = rest.filter((id) => !allowed.has(id));
	if (!rest.length || !(await isOrgFreeBusyEnabled(env))) return allowed;
	for (let index = 0; index < rest.length; index += CHUNK) {
		for (const row of await db.select({ id: users.id }).from(users).where(and(inArray(users.id, rest.slice(index, index + CHUNK)), eq(users.disabled, false), eq(users.calendarEnabled, true)))) allowed.add(row.id);
	}
	return allowed;
}
