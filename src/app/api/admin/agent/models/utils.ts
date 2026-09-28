import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { listCloudflareAgentModels, listCompatibleAgentModels } from "@/lib/agent/provider-models";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";

const requestSchema = z.object({
	provider: z.enum(["cloudflare", "compatible"]),
	preset: z.enum(["openai", "openrouter", "requesty", "groq", "custom"]),
	baseUrl: z.string().max(500),
	apiKey: z.string().max(2_000).optional(),
});

export async function POST(request: Request) {
	const env = getEnv();
	const session = await requireSessionUser(env, request);
	if (session.error) return session.error;
	if (session.user.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = requestSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Invalid provider details" }, { status: 400 });
	try {
		const result = parsed.data.provider === "cloudflare" ? await listCloudflareAgentModels(env) : await listCompatibleAgentModels(env, parsed.data);
		return Response.json(result, { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Unable to load models" }, { status: 400 });
	}
}
