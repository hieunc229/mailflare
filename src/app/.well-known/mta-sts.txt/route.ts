import { getEnv } from "@/lib/cloudflare";
import { serveMtaStsPolicy } from "@/lib/deliverability/mta-sts-serve";

/** RFC 8461 policy for `mta-sts.<domain>`; 404 for every other host (see `serveMtaStsPolicy`). */
export async function GET(request: Request) {
	return serveMtaStsPolicy(getEnv(), request);
}
export const dynamic = "force-dynamic";
