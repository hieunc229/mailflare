import type { domains } from "@/db/schema";

type DomainRow = typeof domains.$inferSelect;

/** Whether mail to external members can leave this domain: a provider is chosen, and Cloudflare sending is switched on. */
export function domainCanSend(domain: Pick<DomainRow, "sendingProvider" | "sendingEnabled">): boolean {
	return domain.sendingProvider !== "none" && (domain.sendingProvider !== "cloudflare" || domain.sendingEnabled);
}
