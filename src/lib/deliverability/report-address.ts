import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domainDeliverability, domains } from "@/db/schema";
import { isMissingTableError } from "@/lib/database-errors";

/** The one address DMARC reports go to on every domain that turned reporting on. It is not a mailbox. */
export const REPORT_ADDRESS_LOCAL_PART = "mailflare-reports";

export const reportAddress = (hostname: string) => `${REPORT_ADDRESS_LOCAL_PART}@${hostname.toLowerCase()}`;

/**
 * The domain a recipient address belongs to when it is the reserved report address of a domain with reporting
 * on, otherwise null. Anything else (including a domain that never enabled reporting) routes as usual, so the
 * reserved address never swallows normal mail. Reads as "off" before the migration is applied.
 */
export async function matchReportAddress(env: Pick<CloudflareEnv, "DB">, to: string): Promise<{ domainId: string; hostname: string } | null> {
	const address = to.trim().toLowerCase();
	const at = address.lastIndexOf("@");
	if (at < 0 || address.slice(0, at) !== REPORT_ADDRESS_LOCAL_PART) return null;
	const hostname = address.slice(at + 1);
	try {
		const [row] = await getDb(env)
			.select({ domainId: domains.id })
			.from(domains)
			.innerJoin(domainDeliverability, eq(domainDeliverability.domainId, domains.id))
			.where(and(eq(domains.hostname, hostname), eq(domainDeliverability.reportsEnabled, true)))
			.limit(1);
		return row ? { domainId: row.domainId, hostname } : null;
	} catch (error) {
		if (isMissingTableError(error)) return null;
		throw error;
	}
}

/**
 * True when `localPart` is the reserved report local part and reporting is on for the domain, so no mailbox or alias may
 * take it (the address is intercepted before any mailbox, so it would silently receive nothing). Reads as false before
 * the migration is applied.
 */
export async function isReportAddressReserved(env: Pick<CloudflareEnv, "DB">, domainId: string, localPart: string): Promise<boolean> {
	if (localPart.trim().toLowerCase() !== REPORT_ADDRESS_LOCAL_PART) return false;
	try {
		const [row] = await getDb(env).select({ domainId: domainDeliverability.domainId }).from(domainDeliverability)
			.where(and(eq(domainDeliverability.domainId, domainId), eq(domainDeliverability.reportsEnabled, true))).limit(1);
		return Boolean(row);
	} catch (error) {
		if (isMissingTableError(error)) return false;
		throw error;
	}
}
