import { getEnv } from "@/lib/cloudflare";
import { RequestBodyTooLargeError } from "@/lib/http/errors";
import { readRawBody } from "@/lib/http/request";
import { isVercelRuntime } from "@/lib/runtime";
import { isQueueName, queueDestination, readQStashConfig, verifyQStashSignature, type QueueEnvelope } from "../../../../../../server/runtime/vercel-queue";
import { consumeQueueMessage } from "../../../../../../server/runtime/vercel-queue-consumer";

export const dynamic = "force-dynamic";
/** Seconds; the ceiling of a Vercel Pro function. */
export const maxDuration = 300;

/** QStash's own message limit. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The queue consumer when QStash is the queue on Vercel: it posts one signed message here. Anything but a 2xx
 * makes QStash deliver it again. 404 on every other runtime, and without QStash (see /api/queues).
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
	if (!isVercelRuntime()) return new Response("Not found", { status: 404 });
	const { name } = await params;
	if (!isQueueName(name)) return new Response("Not found", { status: 404 });
	const env = getEnv();
	const config = readQStashConfig(env as unknown as Record<string, string | undefined>);
	if (!config) return new Response("Not found", { status: 404 });
	let text: string;
	try {
		text = new TextDecoder().decode(await readRawBody(request, MAX_BODY_BYTES));
	} catch (error) {
		if (error instanceof RequestBodyTooLargeError) return new Response("Too large", { status: 413 });
		throw error;
	}
	if (!(await verifyQStashSignature(config, request.headers.get("upstash-signature"), text, queueDestination(env.APP_URL!, name)))) {
		return Response.json({ error: "Invalid signature" }, { status: 401 });
	}
	const envelope = JSON.parse(text) as QueueEnvelope;
	// A redelivery by QStash itself (crash, timeout) counts as an attempt too, so import jobs shrink their chunk.
	const attempt = (Number(envelope.attempt) || 1) + (Number(request.headers.get("upstash-retried")) || 0);
	return Response.json({ outcome: await consumeQueueMessage(env, config, name, envelope.body, attempt) });
}
