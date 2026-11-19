import { z } from "zod";
import { getDb } from "@/db";
import { appSettings } from "@/db/schema";
import { getEnv } from "@/lib/cloudflare";
import { requireSessionUser } from "@/lib/api/auth";
import { isPrimaryAdmin } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { clampOutboundAttachmentMb } from "@/lib/email/attachment-limits";
import { getOutboundAttachmentCeilingMb, getOutboundAttachmentMaxMb } from "@/lib/email/attachment-policy";
import { isNodeRuntime } from "@/lib/runtime";
import { getDriveStorageLimit } from "@/lib/drive/storage";
import { clearDavEnabledCache, isDavEnabled } from "@/lib/dav/settings";
import { isMissingColumnError } from "@/lib/database-errors";

const GIB = 1024 ** 3;

const schema = z.object({
	outboundAttachmentMaxMb: z.number().int().min(1).optional(),
	/** Per-user Drive limit in GB; null removes the limit. */
	driveStorageLimitGb: z.number().positive().max(1_000_000).nullable().optional(),
	/** CalDAV/CardDAV sync; off until an administrator turns it on. */
	davEnabled: z.boolean().optional(),
});

async function readSettings(env: CloudflareEnv) {
	const limit = await getDriveStorageLimit(env);
	clearDavEnabledCache();
	return { outboundAttachmentMaxMb: await getOutboundAttachmentMaxMb(env), outboundAttachmentCeilingMb: getOutboundAttachmentCeilingMb(env), driveStorageLimitGb: limit === null ? null : Math.round((limit / GIB) * 100) / 100, davEnabled: await isDavEnabled(env) };
}

export async function GET(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	return Response.json(await readSettings(env), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
	const env = getEnv();
	const auth = await requireSessionUser(env, request);
	if (auth.error) return auth.error;
	if (!isPrimaryAdmin(auth.user)) return Response.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
	const parsed = schema.safeParse(await request.json().catch(() => null));
	if (!parsed.success || (parsed.data.outboundAttachmentMaxMb === undefined && parsed.data.driveStorageLimitGb === undefined && parsed.data.davEnabled === undefined)) return Response.json({ error: `Enter a valid attachment limit (1 to ${getOutboundAttachmentCeilingMb(env)} MB), Drive storage limit or calendar and contacts sync setting` }, { status: 400 });
	const values: Partial<typeof appSettings.$inferInsert> = { updatedAt: new Date() };
	if (parsed.data.outboundAttachmentMaxMb !== undefined) values.outboundAttachmentMaxMb = clampOutboundAttachmentMb(parsed.data.outboundAttachmentMaxMb, isNodeRuntime(env));
	if (parsed.data.driveStorageLimitGb !== undefined) values.driveStorageLimitBytes = parsed.data.driveStorageLimitGb === null ? null : Math.round(parsed.data.driveStorageLimitGb * GIB);
	if (parsed.data.davEnabled !== undefined) values.davEnabled = parsed.data.davEnabled;
	try {
		await getDb(env).insert(appSettings).values({ id: "default", ...values }).onConflictDoUpdate({ target: appSettings.id, set: values });
	} catch (error) {
		if (!isMissingColumnError(error)) throw error;
		return Response.json({ error: "Apply pending database migrations first." }, { status: 500 });
	}
	return Response.json(await readSettings(env), { headers: { "Cache-Control": "no-store" } });
}
