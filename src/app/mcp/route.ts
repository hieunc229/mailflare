import { getEnv } from "@/lib/cloudflare";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { createMailflareMcpHandler } from "@/lib/mcp/server";
import { allowAgentRequest } from "@/lib/agent/rate-limit";

async function handle(request: Request) {
	const url = new URL(request.url);
	const origin = request.headers.get("Origin");
	if (origin && origin !== url.origin) return new Response("Invalid origin", { status: 403 });
	const env = getEnv();
	const appUrl = env.APP_URL ? new URL(env.APP_URL) : null;
	const forwardedHost = (request.headers.get("x-forwarded-host")?.split(",")[0] ?? request.headers.get("Host") ?? "").trim();
	if (appUrl && forwardedHost !== appUrl.host && url.host !== appUrl.host) return new Response("Invalid host", { status: 403 });
	const effectiveOrigin = appUrl && forwardedHost === appUrl.host ? appUrl.origin : url.origin;
	const principal = await authenticateMcpRequest(env, request);
	if (!principal) return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
	if (!await allowAgentRequest(env, `mcp:${principal.keyId}`)) return new Response("Rate limit exceeded", { status: 429 });
	const handler = createMailflareMcpHandler(env, principal, effectiveOrigin, request.headers.get("Authorization") ?? "");
	try { return await handler.fetch(request); }
	finally { await handler.close(); }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
