import { inArray } from "drizzle-orm";
import type { AppDatabase } from "@/db";
import { mailGroups } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";

/** Group addresses on these domains. A group is optional: before its migration is applied no address belongs to one. */
export async function loadGroupAddresses(db: AppDatabase, domainIds: string[]) {
	if (!domainIds.length) return [];
	try {
		return await db.select({ domainId: mailGroups.domainId, localPart: mailGroups.localPart }).from(mailGroups).where(inArray(mailGroups.domainId, domainIds));
	} catch (error) {
		if (isMissingTableError(error)) return [];
		throw error;
	}
}
