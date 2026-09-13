import { getDb } from "@/db";
import { authenticateApiRequest, hasScope } from "@/lib/api/key-auth";
import { LIMITS } from "./constants";
import { corsHeaders, JmapError, problemResponse } from "./errors";
import { readBlob, storeUpload } from "./blobs";
import { processRequest, sessionState, validateRequest } from "./processor";
import { buildSession } from "./session";
import { getEmailState, getMailboxState } from "./state";
import type { JmapContext } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders() };

/**
 * Entry point for every /jmap/* path and /.well-known/jmap. Returns null for
 * paths it does not own so the caller can fall through.
 */
export async function handleJmapRequest(request: Request, env: CloudflareEnv): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
	if (path === "/.well-known/jmap") {
		return Response.redirect(`${url.origin}/jmap/session`, 301);
	}
	if (!path.startsWith("/jmap/")) return null;

	const auth = await authenticateApiRequest(env, request);
	if (!auth) {
		return new Response(JSON.stringify({ error: "Unauthorized" }), {
			status: 401,
			headers: { ...JSON_HEADERS, "WWW-Authenticate": 'Basic realm="Mailflare JMAP", Bearer' },
		});
	}
	if (!hasScope(auth.scopes, "jmap")) {
		return new Response(JSON.stringify({ error: "This API key does not have the jmap scope" }), { status: 403, headers: JSON_HEADERS });
	}
	const ctx: JmapContext = { env, db: getDb(env), auth, accountId: auth.userId, origin: env.APP_URL?.trim() || url.origin, createdIds: {} };

	if (path === "/jmap/session" && request.method === "GET") {
		return new Response(JSON.stringify(buildSession(ctx, await sessionState(ctx))), { headers: JSON_HEADERS });
	}

	if (path === "/jmap/api" && request.method === "POST") {
		const length = Number(request.headers.get("content-length") ?? 0);
		if (length > LIMITS.maxSizeRequest) return problemResponse("limit", 400, "Request too large", { limit: "maxSizeRequest" });
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return problemResponse("notJSON", 400, "Body is not valid JSON");
		}
		try {
			const response = await processRequest(ctx, validateRequest(body));
			return new Response(JSON.stringify(response), { headers: JSON_HEADERS });
		} catch (error) {
			if (error instanceof JmapError) return problemResponse(error.type, 400, error.message, error.extra);
			throw error;
		}
	}

	const download = path.match(/^\/jmap\/download\/([^/]+)\/([^/]+)\/(.*)$/);
	if (download && request.method === "GET") {
		const [, accountId, blobId, rawName] = download;
		if (decodeURIComponent(accountId) !== ctx.accountId) return new Response("Not found", { status: 404, headers: corsHeaders() });
		const blob = await readBlob(ctx, decodeURIComponent(blobId));
		if (!blob) return new Response("Not found", { status: 404, headers: corsHeaders() });
		const name = decodeURIComponent(rawName) || blob.name || "blob";
		const type = url.searchParams.get("type") || blob.type;
		return new Response(blob.body, {
			headers: {
				"Content-Type": type,
				"Content-Length": String(blob.size),
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
				"Cache-Control": "private, max-age=3600",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				...corsHeaders(),
			},
		});
	}

	const upload = path.match(/^\/jmap\/upload\/([^/]+)$/);
	if (upload && request.method === "POST") {
		if (decodeURIComponent(upload[1]) !== ctx.accountId) return problemResponse("accountNotFound", 404, "Unknown account");
		const type = request.headers.get("content-type") || "application/octet-stream";
		const disposition = request.headers.get("content-disposition") ?? "";
		const name = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? null;
		const stored = await storeUpload(ctx, await request.arrayBuffer(), type, name ? decodeURIComponent(name) : null);
		if (!stored) return problemResponse("limit", 413, "Upload too large", { limit: "maxSizeUpload" });
		return new Response(JSON.stringify(stored), { status: 201, headers: JSON_HEADERS });
	}

	if (path === "/jmap/eventsource" && request.method === "GET") {
		return eventSource(ctx, url);
	}

	return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: JSON_HEADERS });
}

/**
 * Server-sent events. Mailflare has no per-account change log, so the stream
 * sends the current states on connect and again whenever they move, polling
 * every `ping` seconds (default 30, minimum 10) until the client leaves.
 */
function eventSource(ctx: JmapContext, url: URL): Response {
	const ping = Math.max(Number(url.searchParams.get("ping") || 30), 10);
	const closeAfter = url.searchParams.get("closeafter") === "state";
	const encoder = new TextEncoder();
	let last = "";
	let timer: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = async () => {
				const [mailbox, email] = await Promise.all([getMailboxState(ctx), getEmailState(ctx)]);
				const state = `${mailbox}|${email}`;
				if (state === last) {
					controller.enqueue(encoder.encode(`event: ping\ndata: {"interval": ${ping}}\n\n`));
					return;
				}
				last = state;
				const changed = { [ctx.accountId]: { Mailbox: mailbox, Email: email, Thread: email } };
				controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify({ "@type": "StateChange", changed })}\n\n`));
				if (closeAfter) {
					controller.close();
					if (timer) clearInterval(timer);
				}
			};
			await emit();
			if (!closeAfter) timer = setInterval(() => void emit().catch(() => timer && clearInterval(timer)), ping * 1000);
		},
		cancel() {
			if (timer) clearInterval(timer);
		},
	});
	return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", ...corsHeaders() } });
}
