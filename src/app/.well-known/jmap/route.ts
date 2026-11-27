import { getEnv } from "@/lib/cloudflare";
import { handleJmapRequest } from "@/lib/jmap/handler";

/**
 * RFC 8620 §2.2 autodiscovery: redirects to the Session resource, or serves it in place when credentials are sent.
 * POST (an API request) and OPTIONS (CORS preflight) are answered too, for clients that treat this URL as the server address.
 */
async function handle(request: Request) {
	return (await handleJmapRequest(request, getEnv())) ?? new Response("Not found", { status: 404 });
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
export const dynamic = "force-dynamic";
