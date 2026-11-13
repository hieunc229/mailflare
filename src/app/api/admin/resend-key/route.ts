import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getResendKeyStatus } from "@/lib/email/outbound-provider";
import { checkResendKey, resendClient } from "@/lib/email/resend-api";

const schema = z.object({ apiKey: z.string().trim().min(1).max(500) });

async function authorize(request: Request, mutation: boolean) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return { env, error: auth.error };
	if (!isPrimaryAdmin(auth.user)) return { env, error: Response.json({ error: "Only the primary administrator can manage the Resend API key" }, { status: 403 }) };
	if (mutation && !hasValidSessionMutationOrigin(request)) return { env, error: Response.json({ error: "Invalid origin" }, { status: 403 }) };
	return { env, error: null };
}

async function status(env: CloudflareEnv) {
	const { configured, source } = await getResendKeyStatus(env);
	return { configured, source };
}

export async function GET(request: Request) {
	const access = await authorize(request, false);
	if (access.error) return access.error;
	return Response.json(await status(access.env), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return Response.json({ error: "Enter a Resend API key" }, { status: 400 });
	const check = await checkResendKey(resendClient(access.env, parsed.data.apiKey)).catch(() => null);
	if (!check) return Response.json({ error: "Could not reach Resend to check the key" }, { status: 502 });
	if (!check.valid) return Response.json({ error: "Resend rejected this API key" }, { status: 400 });
	const values = { resendApiKey: parsed.data.apiKey, updatedAt: new Date() };
	await getDb(access.env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
	return Response.json({ ...(await status(access.env)), canManageDomains: check.canManageDomains }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: Request) {
	const access = await authorize(request, true);
	if (access.error) return access.error;
	await getDb(access.env).update(appSettings).set({ resendApiKey: null, updatedAt: new Date() }).where(eq(appSettings.id, "default"));
	return Response.json(await status(access.env), { headers: { "Cache-Control": "no-store" } });
}
