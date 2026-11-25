import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "@/db";
import { domainDeliverability, domains } from "@/db/schema";
import { isMissingColumnError, isMissingTableError } from "@/lib/database-errors";
import { buildMtaStsPolicy, hostnameOf, mtaStsHostDomain, normalizeMx, parseMaxAge } from "./mta-sts";

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

function storedMx(value: string | null): string[] | null {
	try {
		return normalizeMx(JSON.parse(value ?? ""));
	} catch {
		return null;
	}
}

/**
 * The policy for `mta-sts.<domain>`, answered for a configured domain only (it has a policy id: testing, enforce, or
 * `none` while the removal period runs). Anything else, including the app's own host name, is a 404. The body is built
 * from stored, re-validated values; nothing from the request is echoed. Never redirects (RFC 8461 forbids it).
 */
export async function serveMtaStsPolicy(env: Pick<CloudflareEnv, "DB">, request: Request): Promise<Response> {
	// The Host header, as the host guards read it: on Node the URL's host is the bind address, not what the sender asked for.
	const domain = mtaStsHostDomain(hostnameOf(request.headers.get("host") ?? new URL(request.url).hostname));
	if (!domain) return notFound();
	let row: { mode: string; mx: string | null; maxAge: number } | undefined;
	try {
		[row] = await getDb(env).select({ mode: domainDeliverability.mtaStsMode, mx: domainDeliverability.mtaStsMx, maxAge: domainDeliverability.mtaStsMaxAge })
			.from(domainDeliverability).innerJoin(domains, eq(domains.id, domainDeliverability.domainId))
			.where(and(eq(domains.hostname, domain), isNotNull(domainDeliverability.mtaStsPolicyId))).limit(1);
	} catch (error) {
		// Before the migration nothing is published.
		if (isMissingTableError(error) || isMissingColumnError(error)) return notFound();
		throw error;
	}
	const mx = storedMx(row?.mx ?? null);
	if (!row || !mx || mx.length === 0 || parseMaxAge(row.maxAge) === null) return notFound();
	let body: string;
	try {
		body = buildMtaStsPolicy({ mode: row.mode, mx, maxAge: row.maxAge });
	} catch {
		return notFound();
	}
	return new Response(request.method === "HEAD" ? null : body, {
		status: 200,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
	});
}
