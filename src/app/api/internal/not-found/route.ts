/** Where the Vercel build sends every other path on an `mta-sts.<domain>` host (next.config.ts). */
function notFound() {
	return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
export const dynamic = "force-dynamic";
